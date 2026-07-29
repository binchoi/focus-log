/**
 * IndexedDB schema. This is the source of truth for the UI; the spreadsheet is
 * a sync target.
 *
 * That inversion is the point. The old app wrote straight to Sheets and deleted
 * its local timer state *before* the network call resolved, so a failed write
 * destroyed the session with nothing but a console error (C1). Here a mutation
 * commits locally and enqueues an outbox op in a single transaction; the network
 * is somebody else's problem.
 */

import Dexie, { type EntityTable } from "dexie";
import type { Goal, Session } from "../sheets/schema";

/** A pending mutation waiting to reach the spreadsheet. */
export interface OutboxOp {
  op_id?: number;
  entity: "goal" | "session";
  /** goal_id or log_id. Lets us collapse repeated edits of one record. */
  entity_id: string;
  /** The full row to append — append-only, so there is no diff to apply. */
  payload: Goal | Session;
  created_at: string;
  attempts: number;
  last_error?: string;
  /** Set when the op is being drained, so a concurrent sync skips it. */
  leased_until?: number;
}

/** An in-progress focus session. At most one row, id "current". */
export interface ActiveSession {
  id: "current";
  goal_id: string;
  /** Closed and open intervals. Duration is their sum — never a tick counter. */
  segments: { start: number; end: number | null }[];
  started_at: number;
  note: string;
  device_id: string;
  updated_at: number;
}

export interface StoredCredentials {
  id: "default";
  clientEmail: string;
  spreadsheetId: string;
  /**
   * Imported with extractable:false, so it can sign JWTs forever but its bytes
   * can never be read back out by script. Verified: exportKey throws
   * InvalidAccessException. structuredClone (and therefore IndexedDB) supports
   * CryptoKey, so this persists across sessions with no re-login.
   */
  privateKey: CryptoKey;
  createdAt: string;
}

export interface SyncMetaRow {
  key: string;
  value: string;
}

export class FocusLogDb extends Dexie {
  goals!: EntityTable<Goal, "goal_id">;
  sessions!: EntityTable<Session, "log_id">;
  outbox!: EntityTable<OutboxOp, "op_id">;
  activeSession!: EntityTable<ActiveSession, "id">;
  credentials!: EntityTable<StoredCredentials, "id">;
  syncMeta!: EntityTable<SyncMetaRow, "key">;

  constructor(name = "focus-log") {
    super(name);
    this.version(1).stores({
      goals: "goal_id, status, sort_order, updated_at, deleted",
      sessions: "log_id, goal_id, local_date, start_utc, updated_at, deleted, [goal_id+local_date]",
      outbox: "++op_id, entity, entity_id, created_at, leased_until",
      activeSession: "id",
      credentials: "id",
      syncMeta: "key",
    });
  }
}

let instance: FocusLogDb | undefined;

export function db(): FocusLogDb {
  instance ??= new FocusLogDb();
  return instance;
}

/** Test hook: swap in an isolated database. */
export function setDbForTests(next: FocusLogDb | undefined): void {
  instance = next;
}

export const SYNC_META_KEYS = {
  lastPullAt: "last_pull_at",
  lastPushAt: "last_push_at",
  lastError: "last_error",
  schemaVersion: "schema_version",
} as const;
