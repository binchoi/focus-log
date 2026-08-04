/**
 * Active-timer lifecycle: the pure bridge between a running {@link TimerState}
 * and the two things the shared sheet holds — the `active` row (so another device
 * can see and control the timer) and, at stop, the finalized `Session` row.
 *
 * The session's `log_id` is minted once at *start* and threaded through here to
 * finalise, so if two devices stop the same timer they append rows with the same
 * id that the last-write-wins reducer collapses — no double-count, no server.
 *
 * Everything here is pure and injected (`logId`, `deviceId`, `now`, `tz`), so it
 * is exhaustively testable and shares golden vectors with the Kotlin core
 * (see /conformance/active-mapping.json).
 */

import { stop, type TimerState } from "./engine";
import { toIsoUtc, localDateOf } from "../time";
import type { ActiveTimer, Session } from "../sheets/schema";
import { compareVersions } from "../sync/merge";

export interface ActiveContext {
  /** The session id, minted at start and reused at finalise. */
  logId: string;
  deviceId: string;
  /** Epoch ms; the LWW clock stamped on the produced row. */
  now: number;
}

/** Publish the current running/paused timer as its shared `active` row. */
export function runningActive(state: TimerState, ctx: ActiveContext): ActiveTimer {
  return {
    log_id: ctx.logId,
    goal_id: state.goalId,
    segments: state.segments,
    note: state.note,
    updated_at: toIsoUtc(new Date(ctx.now)),
    deleted: false,
    device_id: ctx.deviceId,
  };
}

/** The tombstone that ends the shared timer — written on stop or discard. */
export function closedActive(state: TimerState, ctx: ActiveContext): ActiveTimer {
  return { ...runningActive(state, ctx), deleted: true };
}

/**
 * Reconstruct a {@link TimerState} from a pulled `active` row, so another device
 * can display and control a timer it did not start. `startedAt` is recovered from
 * the first segment; elapsed is always re-derived from `segments`, never stored.
 */
export function timerFromActive(active: ActiveTimer): TimerState {
  return {
    goalId: active.goal_id,
    segments: active.segments,
    startedAt: active.segments[0]?.start ?? 0,
    note: active.note,
  };
}

/**
 * The finalized {@link Session} for a stopping timer, under the reserved
 * `log_id`. Focused duration only (pauses excluded), attributed to the local day
 * it started — identical semantics to {@link import("../store/repo").logSession},
 * but pure.
 */
export function finalizedSession(state: TimerState, ctx: ActiveContext & { tz: string }): Session {
  const { start, end, seconds, note } = stop(state, ctx.now);
  return {
    log_id: ctx.logId,
    goal_id: state.goalId,
    start_utc: toIsoUtc(start),
    end_utc: toIsoUtc(end),
    duration_seconds: seconds,
    local_date: localDateOf(start, ctx.tz),
    tz: ctx.tz,
    note: note.trim(),
    source: "timer",
    updated_at: toIsoUtc(new Date(ctx.now)),
    deleted: false,
    device_id: ctx.deviceId,
  };
}

// ---------------------------------------------------------------------------
// Reconcile (what a device's local timer should become after a pull)
// ---------------------------------------------------------------------------

/** When a timer started, recovered from its first segment. */
function startedAtOf(active: ActiveTimer): number {
  return active.segments[0]?.start ?? 0;
}

/**
 * The single shared timer, if any: the earliest-started live (non-tombstoned)
 * record, ties broken by `log_id`. Deterministic so every device agrees on which
 * of several concurrently-started timers is "the" one.
 */
function earliestLive(candidates: ActiveTimer[]): ActiveTimer | undefined {
  let winner: ActiveTimer | undefined;
  for (const c of candidates) {
    if (c.deleted) continue;
    if (
      !winner ||
      startedAtOf(c) < startedAtOf(winner) ||
      (startedAtOf(c) === startedAtOf(winner) && c.log_id < winner.log_id)
    ) {
      winner = c;
    }
  }
  return winner;
}

/** Value equality for the fields that decide whether the local timer must be rewritten. */
function sameActive(a: ActiveTimer | undefined, b: ActiveTimer | undefined): boolean {
  if (!a || !b) return a === b;
  if (
    a.log_id !== b.log_id ||
    a.goal_id !== b.goal_id ||
    a.deleted !== b.deleted ||
    a.note !== b.note ||
    a.device_id !== b.device_id ||
    a.updated_at !== b.updated_at ||
    a.segments.length !== b.segments.length
  ) {
    return false;
  }
  return a.segments.every(
    (s, i) => s.start === b.segments[i]!.start && s.end === b.segments[i]!.end,
  );
}

export interface Reconciliation {
  /** What this device's local timer should become — `undefined` means idle/clear. */
  local: ActiveTimer | undefined;
  /**
   * A `log_id` this device should tombstone: it authored a concurrently-started
   * timer that lost the earliest-start race, so it is auto-closed (no session is
   * logged — a spurious double-start is discarded, not counted).
   */
  closeLogId?: string;
  /** True when `local` differs from the input and must be persisted + broadcast. */
  changed: boolean;
}

/**
 * Reconcile this device's local running timer with the `active` rows pulled from
 * the sheet. Pure and deterministic, so two devices converge on the same shared
 * timer without a server. Never logs a session — finishing is always an explicit
 * user action (see {@link finalizedSession}); this only mirrors *liveness*.
 *
 * Rules, in order:
 *  1. If the sheet has tombstoned *my* timer (same `log_id`, `deleted`), it was
 *     stopped or discarded on another device → go idle.
 *  2. Otherwise adopt any newer remote version of my own timer (LWW), so a pause
 *     or resume from another device shows up here.
 *  3. The shared timer is the earliest-started live record among {remote ∪ mine}.
 *     - idle here → adopt it.
 *     - it's mine → keep it.
 *     - it's a different, earlier timer → adopt it and auto-close mine.
 *
 * `remote` is the reduced-by-`log_id` latest of each active row (tombstones
 * included), i.e. the output of the same LWW reducer used for goals/sessions.
 */
export function reconcileActive(
  local: ActiveTimer | undefined,
  remote: ActiveTimer[],
): Reconciliation {
  const input = local;

  if (local) {
    const current = local;
    const mine = remote.find((r) => r.log_id === current.log_id);
    // (1) my timer was ended elsewhere.
    if (mine?.deleted) return { local: undefined, changed: input !== undefined };
    // (2) adopt a newer remote version of my own timer (another device paused/resumed it).
    if (mine && compareVersions(mine, current) > 0) local = mine;
  }

  const candidates = local ? [...remote, local] : remote;
  const winner = earliestLive(candidates);

  // No live timer anywhere: go/stay idle.
  if (!winner) return { local: undefined, changed: input !== undefined };

  // Was idle: adopt the shared timer.
  if (!local) return { local: winner, changed: true };

  // I hold the shared timer: keep it (possibly the newer version adopted in (2)).
  if (winner.log_id === local.log_id) return { local, changed: !sameActive(input, local) };

  // A different, earlier timer wins: adopt it and auto-close my losing start.
  return { local: winner, closeLogId: local.log_id, changed: true };
}
