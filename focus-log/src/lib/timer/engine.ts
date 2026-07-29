/**
 * Timer engine.
 *
 * The old timer did `setFocusTime(prev => prev + 1)` on a 1s interval and never
 * consulted the clock (C2). Browsers throttle background timers to roughly once
 * a minute, and iOS suspends them outright, so a 60-minute session run in a
 * background tab logged a fraction of the real elapsed time. Compounding it, the
 * adjustment UI refused any value above the recorded time (C3), so the lost time
 * could not be added back.
 *
 * Here a session is a list of intervals and elapsed time is *always* derived
 * from wall-clock timestamps:
 *
 *     elapsed = Σ (closed segments) + (now − open segment start)
 *
 * Ticks only decide when to re-render; they never accumulate. Throttle the tab
 * for an hour and the next tick still reports the correct hour. Pause/resume
 * then falls out of the same structure for free — it was previously impossible.
 */

export interface Segment {
  start: number;
  /** null while running. */
  end: number | null;
}

export interface TimerState {
  goalId: string;
  segments: Segment[];
  startedAt: number;
  note: string;
}

export type TimerPhase = "idle" | "running" | "paused";

/** Prompt the user beyond this; probably a timer left running overnight. */
export const LONG_SESSION_SECONDS = 8 * 60 * 60;
/** Refuse to store beyond this. */
export const MAX_SESSION_SECONDS = 24 * 60 * 60;
/** Below this, warn that the session is trivially short before logging. */
export const SHORT_SESSION_SECONDS = 60;

export function phaseOf(state: TimerState | undefined): TimerPhase {
  if (!state || state.segments.length === 0) return "idle";
  return state.segments.some((s) => s.end === null) ? "running" : "paused";
}

/**
 * Elapsed seconds, derived from timestamps rather than counted.
 *
 * `now` is injected so this is exhaustively testable — including simulating a
 * throttled or suspended tab, which is the bug this replaces.
 */
export function elapsedSeconds(state: TimerState | undefined, now: number): number {
  if (!state) return 0;
  let total = 0;
  for (const segment of state.segments) {
    const end = segment.end ?? now;
    // Guard against a backwards system clock producing negative contributions.
    total += Math.max(0, end - segment.start);
  }
  return Math.floor(total / 1000);
}

export function start(goalId: string, now: number, note = ""): TimerState {
  return { goalId, segments: [{ start: now, end: null }], startedAt: now, note };
}

/** Closes the open segment. No-op if already paused. */
export function pause(state: TimerState, now: number): TimerState {
  if (phaseOf(state) !== "running") return state;
  return {
    ...state,
    segments: state.segments.map((segment) =>
      segment.end === null ? { ...segment, end: Math.max(segment.start, now) } : segment,
    ),
  };
}

/** Opens a new segment. No-op if already running. */
export function resume(state: TimerState, now: number): TimerState {
  if (phaseOf(state) === "running") return state;
  return { ...state, segments: [...state.segments, { start: now, end: null }] };
}

export function toggle(state: TimerState, now: number): TimerState {
  return phaseOf(state) === "running" ? pause(state, now) : resume(state, now);
}

/** Closes the timer and returns the interval to log. */
export function stop(
  state: TimerState,
  now: number,
): { start: Date; end: Date; seconds: number; note: string } {
  const closed = pause(state, now);
  const seconds = elapsedSeconds(closed, now);
  const first = closed.segments[0];
  const startMs = first?.start ?? state.startedAt;
  return {
    // Log the *focused* duration, not the wall-clock span, so pauses are excluded.
    start: new Date(startMs),
    end: new Date(startMs + seconds * 1000),
    seconds,
    note: state.note,
  };
}

export type SessionWarning =
  | { kind: "long"; seconds: number; message: string }
  | { kind: "too_long"; seconds: number; message: string }
  | { kind: "short"; seconds: number; message: string };

/**
 * Guardrails at stop time.
 *
 * The old code silently deleted any stored timer older than 24h (C12) — an
 * overnight session was destroyed with no warning and no recovery. Here the user
 * is always told and always offered a choice.
 */
export function warningFor(seconds: number): SessionWarning | undefined {
  if (seconds > MAX_SESSION_SECONDS) {
    return {
      kind: "too_long",
      seconds,
      message: `This session is ${Math.floor(seconds / 3600)} hours long, which is longer than a day. Trim it before logging.`,
    };
  }
  if (seconds >= LONG_SESSION_SECONDS) {
    return {
      kind: "long",
      seconds,
      message: `That's ${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m. Was the timer left running?`,
    };
  }
  if (seconds < SHORT_SESSION_SECONDS) {
    return {
      kind: "short",
      seconds,
      message: `Only ${seconds}s of focus. Log it anyway, or discard?`,
    };
  }
  return undefined;
}

/**
 * Reconciles a timer restored from storage.
 *
 * A session may have been running when the tab was closed, the laptop slept, or
 * the browser crashed. We never discard it — we hand back the state plus a
 * warning if it now looks implausible, and let the user decide.
 */
export function restore(
  state: TimerState | undefined,
  now: number,
): { state: TimerState | undefined; warning: SessionWarning | undefined } {
  if (!state || state.segments.length === 0) return { state: undefined, warning: undefined };
  const seconds = elapsedSeconds(state, now);
  return { state, warning: warningFor(seconds) };
}

/**
 * Clamps an adjusted duration, allowing increases as well as decreases (C3).
 *
 * NaN means "no value entered" and becomes 0; ±Infinity is an out-of-range
 * value and clamps to the nearest bound, like any other too-large number.
 */
export function clampAdjustment(seconds: number): number {
  if (Number.isNaN(seconds)) return 0;
  return Math.min(MAX_SESSION_SECONDS, Math.max(0, Math.round(seconds)));
}
