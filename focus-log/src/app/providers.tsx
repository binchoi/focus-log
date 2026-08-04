"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { SheetsClient } from "@lib/sheets/client";
import { loadCredentials, tokenProviderFor } from "@lib/auth/credentials";
import type { StoredCredentials } from "@lib/store/db";
import { SyncEngine, type SyncResult } from "@lib/sync/engine";
import { createDebouncedTrigger, installSyncTriggers } from "@lib/sync/triggers";
import { pendingCount } from "@lib/store/repo";
import { createActiveBridge } from "@lib/timer/activeBridge";
import { timerStore } from "@lib/timer/store";

export type ConnectionState = "loading" | "unconfigured" | "ready";

export interface SyncStatus {
  running: boolean;
  /** Queued mutations not yet in the spreadsheet. */
  pending: number;
  lastSyncedAt: Date | undefined;
  /** Set when we deferred because the network was unavailable. */
  offlineReason: string | undefined;
  /** Set when something needs the user to act (permissions, schema). */
  error: string | undefined;
  malformedRows: number;
}

interface AppContextValue {
  connection: ConnectionState;
  credentials: StoredCredentials | undefined;
  status: SyncStatus;
  /** Sync now. Never throws; failures land in `status`. */
  syncNow: () => Promise<void>;
  /** Call after any local mutation to schedule a debounced push. */
  notifyMutation: () => void;
  /** Re-read credentials, e.g. after setup completes. */
  refreshCredentials: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  // Credentials are read as a live query rather than mirrored into state via an
  // effect, so /setup saving them propagates here automatically.
  //
  // Mapped to null when absent so the three states stay distinguishable:
  // undefined = still reading IndexedDB, null = not configured, object = ready.
  const credentials = useLiveQuery(async () => (await loadCredentials()) ?? null, [], undefined);
  const queuedCount = useLiveQuery(() => pendingCount(), [], 0);

  const [running, setRunning] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | undefined>();
  const [offlineReason, setOfflineReason] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [malformedRows, setMalformedRows] = useState(0);

  const connection: ConnectionState =
    credentials === undefined ? "loading" : credentials === null ? "unconfigured" : "ready";

  // One engine per credential set. Derived, not stored in a ref, so it cannot be
  // read during render before it exists.
  const engine = useMemo(() => {
    if (!credentials) return undefined;
    return new SyncEngine(
      new SheetsClient({
        spreadsheetId: credentials.spreadsheetId,
        tokens: tokenProviderFor(credentials),
      }),
      { active: createActiveBridge() },
    );
  }, [credentials]);

  const applyResult = useCallback((result: SyncResult) => {
    setRunning(false);
    // Only claim a successful sync when we actually reached the sheet.
    if (!result.deferred) setLastSyncedAt(new Date());
    setOfflineReason(result.deferred ? result.deferredReason : undefined);
    setError(undefined);
    setMalformedRows(result.malformed.goals.length + result.malformed.sessions.length);
  }, []);

  const syncNow = useCallback(async () => {
    if (!engine) return;
    setRunning(true);
    try {
      applyResult(await engine.sync());
    } catch (cause) {
      // Reaching here means a real misconfiguration (sharing, schema, revoked
      // key) rather than a transient network problem — surface it, don't retry.
      setRunning(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [engine, applyResult]);

  // Saving or clearing credentials writes to IndexedDB, which the live query
  // above already observes — so callers need not do anything else. Kept as an
  // awaitable no-op so /setup and /settings can sequence their navigation.
  const refreshCredentials = useCallback(async () => {}, []);

  const debounced = useMemo(() => createDebouncedTrigger(() => void syncNow()), [syncNow]);

  const notifyMutation = useCallback(() => {
    debounced.request("mutation");
  }, [debounced]);

  useEffect(() => {
    if (!engine) return undefined;
    // installSyncTriggers fires its startup sync on a timeout, so nothing here
    // updates state synchronously during the effect.
    const teardown = installSyncTriggers({ onTrigger: () => void syncNow(), immediate: true });
    // Timer changes (start/pause/resume/stop) schedule a debounced sync too, so
    // the shared `active` row reaches other devices promptly rather than waiting
    // for the 60s poll. Adopting a remote timer enqueues nothing, so reconcile
    // quiesces after one cycle — no feedback loop.
    const unsubscribeTimer = timerStore().subscribe(() => debounced.request("timer"));
    // Unlike the old code's uncleaned setInterval (C5), every listener and timer
    // registered here is torn down.
    return () => {
      teardown();
      unsubscribeTimer();
      debounced.cancel();
    };
  }, [engine, syncNow, debounced]);

  const status = useMemo<SyncStatus>(
    () => ({
      running,
      pending: queuedCount ?? 0,
      lastSyncedAt,
      offlineReason,
      error,
      malformedRows,
    }),
    [running, queuedCount, lastSyncedAt, offlineReason, error, malformedRows],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      connection,
      credentials: credentials ?? undefined,
      status,
      syncNow,
      notifyMutation,
      refreshCredentials,
    }),
    [connection, credentials, status, syncNow, notifyMutation, refreshCredentials],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside <AppProvider>");
  return value;
}
