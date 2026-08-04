/**
 * Sync orchestrator: pull, merge, push.
 *
 * Pull reads all three tabs in one batchGet, collapses the append-only log by
 * last-write-wins, and merges against the local mirror. Push drains the outbox
 * in batched appends.
 *
 * The outbox is drained under a *lease* rather than deleted optimistically. A
 * naive "delete then send" loses work if the tab closes mid-flight; a naive
 * "send then delete" can double-send. Leasing plus client-minted ids means the
 * worst case is an identical row appended twice, which the reducer collapses
 * (see merge.ts) — so a lost response is harmless.
 */

import { RANGES } from "../sheets/columns";
import type { SheetsClient } from "../sheets/client";
import { SheetsError } from "../sheets/client";
import {
  activeToRow,
  goalToRow,
  parseActiveRows,
  parseGoalRows,
  parseMetaRows,
  parseSessionRows,
  sessionToRow,
  type ActiveTimer,
  type Goal,
  type ParseFailure,
  type Session,
} from "../sheets/schema";
import { SCHEMA_VERSION } from "../sheets/columns";
import { db, SYNC_META_KEYS, type FocusLogDb, type OutboxOp } from "../store/db";
import { mergeRecords, reduceLatest } from "./merge";
import { reconcileActive, type Reconciliation } from "../timer/lifecycle";

/**
 * Bridges the sync engine to the device's running timer without coupling it to
 * the timer store. Pull hands the reconciled result back through `apply`; the
 * engine never touches `activeSession` directly.
 */
export interface ActiveBridge {
  /** This device's current timer as an `active` record, or undefined when idle. */
  readLocal(): Promise<ActiveTimer | undefined>;
  /** Persist the reconciliation: write/clear the local timer and enqueue any auto-close. */
  apply(result: Reconciliation): Promise<void>;
}

export interface SyncResult {
  pulled: { goals: number; sessions: number };
  pushed: number;
  /** Ops still queued after this run (network still down, or retry backoff). */
  stillPending: number;
  /** Rows the sheet holds that we could not parse. Surfaced, never swallowed. */
  malformed: { goals: ParseFailure[]; sessions: ParseFailure[] };
  schemaVersion: number | undefined;
  /**
   * True when the network was unreachable (or Google was rate-limiting/erroring)
   * and we deferred rather than failed. Being offline is an ordinary state for
   * this app, not an exception — callers show a "pending" badge, not an error.
   */
  deferred: boolean;
  /** Set when `deferred` is true, for display in the sync status UI. */
  deferredReason?: string;
}

/** What a pull contributes to a SyncResult. */
export type PullResult = Pick<SyncResult, "pulled" | "malformed" | "schemaVersion">;

export interface SyncOptions {
  database?: FocusLogDb;
  now?: () => Date;
  /** How long a drained op stays leased before another run may retry it. */
  leaseMs?: number;
  /** Give up on an op after this many failures, but never delete it. */
  maxAttempts?: number;
  /** Cross-device running timer. Omitted → the `active` tab is never touched. */
  active?: ActiveBridge;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 10;

export class SyncEngine {
  private readonly database: FocusLogDb;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly active?: ActiveBridge;
  /** Serialises runs so two triggers cannot drain the outbox concurrently. */
  private inFlight: Promise<SyncResult> | undefined;

  constructor(
    private readonly client: SheetsClient,
    options: SyncOptions = {},
  ) {
    this.database = options.database ?? db();
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.active = options.active;
  }

  /**
   * Full sync. Concurrent callers share the in-flight run rather than starting
   * a second one — several triggers (online, visibility, timer, poll) can fire
   * at once.
   */
  async sync(): Promise<SyncResult> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(): Promise<SyncResult> {
    // Push first: local work is what we can least afford to lose, and pushing
    // before pulling means the merge sees our own rows and won't report them as
    // remote changes.
    let deferredReason: string | undefined;

    // push() defers retryable failures itself and reports why; anything it
    // throws is a real misconfiguration (403 permission, 404 missing tab) that
    // the user has to fix, so it propagates.
    const pushOutcome = await this.push();
    const pushed = pushOutcome.pushed;
    deferredReason = pushOutcome.deferredReason;

    let pulled: PullResult = {
      pulled: { goals: 0, sessions: 0 },
      malformed: { goals: [], sessions: [] },
      schemaVersion: undefined,
    };
    try {
      pulled = await this.pull();
    } catch (error) {
      // Offline / 429 / 5xx: defer, don't fail. The queue is intact and the next
      // trigger will retry.
      if (error instanceof SheetsError && error.retryable) {
        deferredReason = error.message;
        await this.setMeta(SYNC_META_KEYS.lastError, error.message);
      } else {
        throw error;
      }
    }

    return {
      ...pulled,
      pushed,
      stillPending: await this.database.outbox.count(),
      deferred: deferredReason !== undefined,
      ...(deferredReason !== undefined ? { deferredReason } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Pull
  // -------------------------------------------------------------------------

  async pull(): Promise<PullResult> {
    const raw = await this.client.readAll();

    const remoteGoals = parseGoalRows(raw.goals);
    const remoteSessions = parseSessionRows(raw.sessions);
    const meta = parseMetaRows(raw.meta);
    const schemaVersion = Number(meta[SYNC_META_KEYS.schemaVersion] ?? meta.schema_version);

    const [localGoals, localSessions] = await Promise.all([
      this.database.goals.toArray(),
      this.database.sessions.toArray(),
    ]);

    const goalMerge = mergeRecords(localGoals, remoteGoals.records, (g) => g.goal_id);
    const sessionMerge = mergeRecords(localSessions, remoteSessions.records, (s) => s.log_id);

    // Only write back what actually changed, so a no-op sync doesn't churn
    // IndexedDB and wake every live query.
    await this.database.transaction("rw", this.database.goals, this.database.sessions, async () => {
      if (goalMerge.changedLocally.length)
        await this.database.goals.bulkPut(goalMerge.changedLocally);
      if (sessionMerge.changedLocally.length) {
        await this.database.sessions.bulkPut(sessionMerge.changedLocally);
      }
    });

    const resolvedSchema = Number.isFinite(schemaVersion) ? schemaVersion : undefined;
    // Cache the sheet's schema so push (which runs before pull) knows whether the
    // `active` tab exists without an extra round-trip.
    await this.setMeta(
      SYNC_META_KEYS.schemaVersion,
      resolvedSchema === undefined ? "" : String(resolvedSchema),
    );
    await this.reconcileActiveTimer(resolvedSchema);

    await this.setMeta(SYNC_META_KEYS.lastPullAt, this.now().toISOString());

    return {
      pulled: {
        goals: goalMerge.changedLocally.length,
        sessions: sessionMerge.changedLocally.length,
      },
      malformed: { goals: remoteGoals.failures, sessions: remoteSessions.failures },
      schemaVersion: resolvedSchema,
    };
  }

  /**
   * Pull the `active` tab and reconcile it into this device's running timer.
   * Only on a v2+ sheet with a bridge wired — a v1 sheet has no `active` tab, so
   * the cross-device timer is simply off (no extra request, no error). Reconcile
   * is idempotent, so the `apply` bridge can safely skip a stale write.
   */
  private async reconcileActiveTimer(schemaVersion: number | undefined): Promise<void> {
    if (!this.active || schemaVersion === undefined || schemaVersion < 2) return;

    const rows = await this.client.readActive();
    if (rows === null) return; // tab absent → feature off, gracefully.

    const parsed = parseActiveRows(rows);
    const remote = [...reduceLatest(parsed.records, (a) => a.log_id).values()];
    const local = await this.active.readLocal();
    const result = reconcileActive(local, remote);
    if (result.changed || result.closeLogId !== undefined) await this.active.apply(result);
  }

  // -------------------------------------------------------------------------
  // Push
  // -------------------------------------------------------------------------

  /** Drains the outbox. Retryable failures are deferred, not thrown. */
  async push(): Promise<{ pushed: number; deferredReason?: string }> {
    const claimed = await this.claim();
    if (claimed.length === 0) return { pushed: 0 };

    const goalOps = claimed.filter((op) => op.entity === "goal");
    const sessionOps = claimed.filter((op) => op.entity === "session");
    const activeOps = claimed.filter((op) => op.entity === "active");

    // Goals go first: a session referencing a goal the sheet hasn't seen yet
    // would look like an orphan to anyone reading mid-sync.
    const goals = await this.pushBatch(goalOps, RANGES.goals, (op) =>
      goalToRow(op.payload as Goal),
    );
    const sessions = await this.pushBatch(sessionOps, RANGES.sessions, (op) =>
      sessionToRow(op.payload as Session),
    );
    // The active timer is a best-effort broadcast, and only a v2 sheet has an
    // `active` tab. Gate on the schema version learned by the last pull so a v1
    // sheet is never even *asked* to append it — appending would 400, which the
    // browser logs as a console error even though we'd drop it. If the sheet
    // can't hold the timer, drop the ops silently; the running timer re-publishes
    // on its next change once we know the sheet is v2.
    const cachedSchema = Number(
      (await this.database.syncMeta.get(SYNC_META_KEYS.schemaVersion))?.value,
    );
    let active: { pushed: number; deferredReason?: string } = { pushed: 0 };
    if (Number.isFinite(cachedSchema) && cachedSchema >= 2) {
      active = await this.pushBatch(
        activeOps,
        RANGES.active,
        (op) => activeToRow(op.payload as ActiveTimer),
        { dropOnFatal: true },
      );
    } else if (activeOps.length > 0) {
      await this.database.outbox.bulkDelete(activeOps.map((op) => op.op_id!));
    }

    const pushed = goals.pushed + sessions.pushed + active.pushed;
    if (pushed > 0) await this.setMeta(SYNC_META_KEYS.lastPushAt, this.now().toISOString());
    const deferredReason = goals.deferredReason ?? sessions.deferredReason ?? active.deferredReason;
    return { pushed, ...(deferredReason !== undefined ? { deferredReason } : {}) };
  }

  /**
   * Marks ops as in-flight so a concurrent run skips them, and returns them.
   * Expired leases are reclaimed, which is how a tab that died mid-push gets
   * its work retried.
   */
  private async claim(): Promise<OutboxOp[]> {
    const nowMs = this.now().getTime();
    return this.database.transaction("rw", this.database.outbox, async () => {
      const all = await this.database.outbox.orderBy("op_id").toArray();
      const available = all.filter(
        (op) =>
          (op.leased_until === undefined || op.leased_until < nowMs) &&
          op.attempts < this.maxAttempts,
      );
      if (available.length === 0) return [];
      await this.database.outbox.bulkPut(
        available.map((op) => ({ ...op, leased_until: nowMs + this.leaseMs })),
      );
      return available;
    });
  }

  private async pushBatch(
    ops: OutboxOp[],
    range: string,
    toRow: (op: OutboxOp) => (string | number | boolean | null | undefined)[],
    options: { dropOnFatal?: boolean } = {},
  ): Promise<{ pushed: number; deferredReason?: string }> {
    if (ops.length === 0) return { pushed: 0 };

    try {
      await this.client.append(range, ops.map(toRow));
    } catch (error) {
      // A retryable failure (offline, 429, 5xx) is expected, not exceptional:
      // the ops stay queued and the next trigger picks them up.
      if (error instanceof SheetsError && error.retryable) {
        await this.releaseWithError(ops, error);
        return { pushed: 0, deferredReason: error.message };
      }
      // Non-retryable: for best-effort entities (the active timer), the sheet
      // simply can't hold this row — drop the ops so they don't wedge the queue
      // as stuck. For durable entities it's a real misconfiguration: surface it.
      if (options.dropOnFatal) {
        await this.database.outbox.bulkDelete(ops.map((op) => op.op_id!));
        return { pushed: 0 };
      }
      await this.releaseWithError(ops, error);
      throw error;
    }

    // Confirmed appended: only now is it safe to forget the op.
    await this.database.outbox.bulkDelete(ops.map((op) => op.op_id!));
    return { pushed: ops.length };
  }

  private async releaseWithError(ops: OutboxOp[], error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.database.outbox.bulkPut(
      ops.map((op) => ({
        ...op,
        attempts: op.attempts + 1,
        last_error: message,
        leased_until: undefined,
      })),
    );
    await this.setMeta(SYNC_META_KEYS.lastError, message);
  }

  private async setMeta(key: string, value: string): Promise<void> {
    await this.database.syncMeta.put({ key, value });
  }

  /** Ops that exhausted their retries and need the user to intervene. */
  async stuckOps(): Promise<OutboxOp[]> {
    const all = await this.database.outbox.toArray();
    return all.filter((op) => op.attempts >= this.maxAttempts);
  }
}

export function isSchemaCompatible(remoteVersion: number | undefined): boolean {
  // An older sheet is fine to read and write — the app simply leaves newer,
  // additive features (the `active` tab) disabled until the sheet is migrated.
  // A *newer* sheet means another device is ahead of this build, and writing to
  // it could drop columns we don't know about, so that we still refuse.
  return remoteVersion === undefined || remoteVersion <= SCHEMA_VERSION;
}
