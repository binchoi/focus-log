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
