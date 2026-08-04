/**
 * Mutations against the local store.
 *
 * Every mutation writes the record *and* its outbox op inside one Dexie
 * transaction. That single transaction is the commit point the UI reports as
 * "saved" — not the HTTP response. If the browser dies immediately afterwards,
 * the op is still queued; if the network is down for a week, nothing is lost.
 *
 * This is the structural fix for C1, where the old code removed its localStorage
 * timer state before calling appendLog() and swallowed failures with
 * .catch(console.error).
 */

import { db, type FocusLogDb, type OutboxOp } from "./db";
import { getDeviceId, newId } from "./ids";
import {
  GoalSchema,
  SessionSchema,
  type ActiveTimer,
  type Goal,
  type Session,
} from "../sheets/schema";
import { durationSeconds, localDateOf, toIsoUtc, currentTimeZone } from "../time";

/** Injected so tests are deterministic and don't depend on the wall clock. */
export interface RepoContext {
  database?: FocusLogDb;
  now?: () => Date;
  deviceId?: () => string;
  timeZone?: () => string;
}

function ctx(context: RepoContext = {}) {
  return {
    database: context.database ?? db(),
    now: context.now ?? (() => new Date()),
    deviceId: context.deviceId ?? getDeviceId,
    timeZone: context.timeZone ?? currentTimeZone,
  };
}

/** Longest session we will accept. Guards against a runaway timer (C12). */
export const MAX_SESSION_SECONDS = 24 * 60 * 60;

export interface CreateGoalInput {
  title: string;
  color?: string;
  weekly_target_minutes?: number;
  sort_order?: number;
}

export async function createGoal(input: CreateGoalInput, context: RepoContext = {}): Promise<Goal> {
  const { database, now, deviceId } = ctx(context);
  const timestamp = toIsoUtc(now());

  const goal = GoalSchema.parse({
    goal_id: newId(),
    title: input.title.trim(),
    color: input.color ?? "#4caf50",
    weekly_target_minutes: input.weekly_target_minutes ?? 0,
    sort_order: input.sort_order ?? 0,
    status: "active",
    created_at: timestamp,
    updated_at: timestamp,
    deleted: false,
    device_id: deviceId(),
  });

  await commit(database, "goal", goal.goal_id, goal, () => database.goals.put(goal));
  return goal;
}

export async function updateGoal(
  goalId: string,
  patch: Partial<Omit<Goal, "goal_id" | "created_at">>,
  context: RepoContext = {},
): Promise<Goal> {
  const { database, now, deviceId } = ctx(context);
  const existing = await database.goals.get(goalId);
  if (!existing) throw new Error(`No such goal: ${goalId}`);

  const goal = GoalSchema.parse({
    ...existing,
    ...patch,
    goal_id: existing.goal_id,
    created_at: existing.created_at,
    updated_at: toIsoUtc(now()),
    device_id: deviceId(),
  });

  await commit(database, "goal", goal.goal_id, goal, () => database.goals.put(goal));
  return goal;
}

/**
 * Soft-deletes a goal. The tombstone is what propagates the delete to other
 * devices, so the row is kept rather than removed.
 */
export async function deleteGoal(goalId: string, context: RepoContext = {}): Promise<void> {
  await updateGoal(goalId, { deleted: true, status: "archived" }, context);
}

export interface LogSessionInput {
  goal_id: string;
  start: Date;
  end: Date;
  note?: string;
  source?: Session["source"];
  /**
   * Overrides the computed duration, for the "adjust before logging" flow.
   * Allowed in *both* directions — the old UI refused any value above the
   * recorded time (C3), which meant a session under-counted by background
   * throttling (C2) could never be corrected.
   */
  durationSecondsOverride?: number;
  /**
   * Reuse a pre-minted id instead of generating one. The cross-device timer mints
   * the session id at *start* (on the shared `active` row) and finalises under it,
   * so two devices ending the same timer produce same-id rows the reducer
   * collapses. Omitted for ordinary manual/timer logging, which mints fresh.
   */
  logId?: string;
}

export async function logSession(
  input: LogSessionInput,
  context: RepoContext = {},
): Promise<Session> {
  const { database, now, deviceId, timeZone } = ctx(context);
  const tz = timeZone();

  const computed = durationSeconds(input.start, input.end);
  const duration = input.durationSecondsOverride ?? computed;

  if (duration < 0) throw new Error("A session cannot have a negative duration.");
  if (duration > MAX_SESSION_SECONDS) {
    throw new Error(
      `A session cannot exceed ${MAX_SESSION_SECONDS / 3600} hours. Trim it before logging.`,
    );
  }

  // When the duration is adjusted, move `end` to match so start/end/duration
  // stay mutually consistent in the sheet.
  const end = duration === computed ? input.end : new Date(input.start.getTime() + duration * 1000);

  const session = SessionSchema.parse({
    log_id: input.logId ?? newId(),
    goal_id: input.goal_id,
    start_utc: toIsoUtc(input.start),
    end_utc: toIsoUtc(end),
    duration_seconds: duration,
    // Attribute the session to the local day it *started*, in the zone the user
    // was actually in. Storing the zone too is what makes this readable later.
    local_date: localDateOf(input.start, tz),
    tz,
    note: input.note?.trim() ?? "",
    source: input.source ?? "timer",
    updated_at: toIsoUtc(now()),
    deleted: false,
    device_id: deviceId(),
  });

  await commit(database, "session", session.log_id, session, () => database.sessions.put(session));
  return session;
}

export async function updateSession(
  logId: string,
  patch: Partial<Pick<Session, "goal_id" | "note" | "duration_seconds" | "start_utc">>,
  context: RepoContext = {},
): Promise<Session> {
  const { database, now, deviceId, timeZone } = ctx(context);
  const existing = await database.sessions.get(logId);
  if (!existing) throw new Error(`No such session: ${logId}`);

  const start = new Date(patch.start_utc ?? existing.start_utc);
  const duration = patch.duration_seconds ?? existing.duration_seconds;
  if (duration < 0 || duration > MAX_SESSION_SECONDS) {
    throw new Error("Session duration out of range.");
  }
  const tz = existing.tz || timeZone();

  const session = SessionSchema.parse({
    ...existing,
    ...patch,
    log_id: existing.log_id,
    start_utc: toIsoUtc(start),
    end_utc: toIsoUtc(new Date(start.getTime() + duration * 1000)),
    duration_seconds: duration,
    local_date: localDateOf(start, tz),
    tz,
    updated_at: toIsoUtc(now()),
    device_id: deviceId(),
  });

  await commit(database, "session", session.log_id, session, () => database.sessions.put(session));
  return session;
}

export async function deleteSession(logId: string, context: RepoContext = {}): Promise<void> {
  const { database, now, deviceId } = ctx(context);
  const existing = await database.sessions.get(logId);
  if (!existing) throw new Error(`No such session: ${logId}`);

  const tombstone: Session = {
    ...existing,
    deleted: true,
    updated_at: toIsoUtc(now()),
    device_id: deviceId(),
  };
  await commit(database, "session", logId, tombstone, () => database.sessions.put(tombstone));
}

/**
 * Applies the local write and enqueues the outbox op atomically.
 *
 * Repeated edits to the same record collapse to one queued op: only the newest
 * version needs to reach the sheet, and appending every intermediate version
 * would bloat it for no benefit.
 */
async function commit(
  database: FocusLogDb,
  entity: OutboxOp["entity"],
  entityId: string,
  payload: Goal | Session,
  write: () => Promise<unknown>,
): Promise<void> {
  await database.transaction("rw", database.goals, database.sessions, database.outbox, async () => {
    await write();
    const pending = await database.outbox.where("entity_id").equals(entityId).toArray();
    // Supersede only ops of the SAME entity: a session and an active-timer row
    // share a log_id, so matching entity_id alone would let a finalising timer's
    // active tombstone delete the very session being logged. And only ops not
    // being drained, so we never discard a row already in flight.
    const supersedable = pending.filter((op) => !op.leased_until && op.entity === entity);
    if (supersedable.length > 0) {
      await database.outbox.bulkDelete(supersedable.map((op) => op.op_id!));
    }
    await database.outbox.add({
      entity,
      entity_id: entityId,
      payload,
      created_at: payload.updated_at,
      attempts: 0,
    });
  });
}

/**
 * Queues the shared active-timer row (running/paused publish, or a `deleted`
 * tombstone) for the sheet. Unlike {@link commit}, there is no local record to
 * write — the running timer's local home is the `activeSession` store. Collapses
 * to one op per `log_id`, so rapid pause/resume never bloats the queue.
 */
export async function enqueueActive(
  payload: ActiveTimer,
  context: RepoContext = {},
): Promise<void> {
  const { database } = ctx(context);
  await database.transaction("rw", database.outbox, async () => {
    const pending = await database.outbox.where("entity_id").equals(payload.log_id).toArray();
    // Same-entity only: never collapse a queued session that happens to share
    // this timer's log_id (see the note in commit()).
    const supersedable = pending.filter((op) => !op.leased_until && op.entity === "active");
    if (supersedable.length > 0) {
      await database.outbox.bulkDelete(supersedable.map((op) => op.op_id!));
    }
    await database.outbox.add({
      entity: "active",
      entity_id: payload.log_id,
      payload,
      created_at: payload.updated_at,
      attempts: 0,
    });
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listGoals(context: RepoContext = {}): Promise<Goal[]> {
  const { database } = ctx(context);
  const goals = await database.goals.toArray();
  return goals
    .filter((g) => !g.deleted)
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
}

export async function listSessions(
  filter: { goalId?: string; from?: string; to?: string } = {},
  context: RepoContext = {},
): Promise<Session[]> {
  const { database } = ctx(context);
  const all = await database.sessions.toArray();
  return all
    .filter((s) => !s.deleted)
    .filter((s) => (filter.goalId ? s.goal_id === filter.goalId : true))
    .filter((s) => (filter.from ? s.local_date >= filter.from : true))
    .filter((s) => (filter.to ? s.local_date <= filter.to : true))
    .sort((a, b) => b.start_utc.localeCompare(a.start_utc));
}

/** Total focused seconds per goal id. Computed locally, never from a formula (C13). */
export async function totalsByGoal(
  filter: { from?: string; to?: string } = {},
  context: RepoContext = {},
): Promise<Map<string, number>> {
  const sessions = await listSessions(filter, context);
  const totals = new Map<string, number>();
  for (const session of sessions) {
    totals.set(session.goal_id, (totals.get(session.goal_id) ?? 0) + session.duration_seconds);
  }
  return totals;
}

export async function pendingCount(context: RepoContext = {}): Promise<number> {
  const { database } = ctx(context);
  return database.outbox.count();
}
