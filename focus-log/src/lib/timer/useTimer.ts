"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  elapsedSeconds,
  pause,
  phaseOf,
  restore,
  resume,
  start as startTimer,
  stop as stopTimer,
  warningFor,
  type SessionWarning,
  type TimerPhase,
  type TimerState,
} from "./engine";
import { timerStore, type TimerStore } from "./store";

export interface UseTimerResult {
  phase: TimerPhase;
  /** Elapsed focused seconds, recomputed from the clock on every tick. */
  seconds: number;
  /** The goal the running timer belongs to, if any. */
  activeGoalId: string | undefined;
  /** True when a timer is running for a *different* goal than the one asked about. */
  blockedByOtherGoal: boolean;
  warning: SessionWarning | undefined;
  ready: boolean;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  /** Ends the timer and returns what to log. Does not write to the store. */
  stop: () => Promise<{ start: Date; end: Date; seconds: number; note: string } | undefined>;
  discard: () => Promise<void>;
  setNote: (note: string) => Promise<void>;
}

/**
 * Drives the timer for one goal.
 *
 * The interval here only re-samples the clock; it never accumulates. The
 * displayed value is always `elapsedSeconds(state, now)` where `now` was
 * overwritten with a fresh Date.now(). That is the C2 fix — a throttled or
 * suspended tab simply renders less often, and the number is still right.
 *
 * Unlike the old implementation, the interval is cleared on unmount and when the
 * timer stops, so navigating away no longer leaks it (C5).
 */
export function useTimer(goalId: string | undefined, store: TimerStore = timerStore()): UseTimerResult {
  // The running session is external state (IndexedDB, shared across tabs), so it
  // is read through useSyncExternalStore rather than mirrored into useState.
  const state = useSyncExternalStore(
    useCallback((onChange) => store.subscribe(() => onChange()), [store]),
    () => store.snapshot(),
    () => undefined,
  );
  const ready = store.loaded;

  // `now` is advanced by the interval below and read during render. Crucially it
  // is a *sampled clock*, not an accumulator: each update overwrites it with the
  // real Date.now(), so the number of times the interval fired is irrelevant.
  // That is what makes a throttled or suspended tab still report the correct
  // elapsed time (C2).
  const [now, setNow] = useState(() => Date.now());
  const [warning, setWarning] = useState<SessionWarning | undefined>();

  useEffect(() => {
    void store.load().then((stored) => {
      const restored = restore(stored, Date.now());
      if (restored.warning) setWarning(restored.warning);
    });
  }, [store]);

  const phase = phaseOf(state);
  const isRunningHere = phase === "running" && state?.goalId === goalId;

  // Tick only while this goal's timer is actually running.
  useEffect(() => {
    if (!isRunningHere) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    // Always cleaned up — the old implementation stored the handle in state and
    // returned no cleanup at all, leaking the interval on unmount (C5).
    return () => clearInterval(interval);
  }, [isRunningHere]);

  // Re-render as soon as the tab becomes visible so the display jumps straight
  // to the correct value instead of waiting up to a second.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const bump = () => {
      // Re-sample immediately on return so the display jumps straight to the
      // correct value rather than waiting up to a second.
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", bump);
    window.addEventListener("focus", bump);
    return () => {
      document.removeEventListener("visibilitychange", bump);
      window.removeEventListener("focus", bump);
    };
  }, []);

  const belongsToThisGoal = state?.goalId === goalId;
  const seconds = belongsToThisGoal ? elapsedSeconds(state, now) : 0;

  const start = useCallback(async () => {
    if (!goalId) return;
    // Refuse to start on top of another goal's timer; the caller surfaces
    // `blockedByOtherGoal` instead.
    const current = await store.read();
    if (current && current.goalId !== goalId) return;
    const at = Date.now();
    await store.write(startTimer(goalId, at), at);
    setWarning(undefined);
  }, [goalId, store]);

  const doPause = useCallback(async () => {
    if (!state || !belongsToThisGoal) return;
    const at = Date.now();
    await store.write(pause(state, at), at);
  }, [state, belongsToThisGoal, store]);

  const doResume = useCallback(async () => {
    if (!state || !belongsToThisGoal) return;
    const at = Date.now();
    await store.write(resume(state, at), at);
  }, [state, belongsToThisGoal, store]);

  const stop = useCallback(async () => {
    if (!state || !belongsToThisGoal) return undefined;
    const result = stopTimer(state, Date.now());
    setWarning(warningFor(result.seconds));
    // Deliberately does not clear the store: the session is only released once
    // the caller has committed or explicitly discarded it, so a crash mid-dialog
    // cannot lose it.
    await store.write(pause(state, Date.now()), Date.now());
    return result;
  }, [state, belongsToThisGoal, store]);

  const discard = useCallback(async () => {
    if (!goalId) return;
    await store.clearIfGoal(goalId);
    setWarning(undefined);
  }, [goalId, store]);

  const setNote = useCallback(
    async (note: string) => {
      if (!state || !belongsToThisGoal) return;
      await store.write({ ...state, note }, Date.now());
    },
    [state, belongsToThisGoal, store],
  );

  return {
    phase: belongsToThisGoal ? phase : "idle",
    seconds,
    activeGoalId: state?.goalId,
    blockedByOtherGoal: state !== undefined && !belongsToThisGoal && phase !== "idle",
    warning,
    ready,
    start,
    pause: doPause,
    resume: doResume,
    stop,
    discard,
    setNote,
  };
}
