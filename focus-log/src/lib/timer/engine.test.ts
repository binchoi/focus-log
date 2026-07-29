import { describe, expect, it } from "vitest";
import {
  LONG_SESSION_SECONDS,
  MAX_SESSION_SECONDS,
  clampAdjustment,
  elapsedSeconds,
  pause,
  phaseOf,
  restore,
  resume,
  start,
  stop,
  toggle,
  warningFor,
  type TimerState,
} from "./engine";

const T0 = Date.parse("2026-07-29T10:00:00.000Z");
const minutes = (n: number) => n * 60_000;

describe("C2 regression: elapsed time is derived from the clock, never counted", () => {
  it("reports the full hour even if the tab only ticked twice", () => {
    // This is the actual bug. The old timer did `prev + 1` per interval fire;
    // a hidden tab fires roughly once a minute (and iOS suspends entirely), so
    // an hour of real focus logged as a couple of minutes.
    const state = start("goal-1", T0);

    // Simulate a throttled tab: only two ticks in an hour. The number of ticks
    // is irrelevant — elapsed depends solely on the timestamps.
    expect(elapsedSeconds(state, T0 + minutes(30))).toBe(1800);
    expect(elapsedSeconds(state, T0 + minutes(60))).toBe(3600);
  });

  it("is identical whether the tab ticked 3600 times or once", () => {
    const state = start("goal-1", T0);
    const oneTick = elapsedSeconds(state, T0 + minutes(60));

    // Ticking every second changes nothing, because ticks don't accumulate.
    let last = 0;
    for (let second = 1; second <= 3600; second += 1) {
      last = elapsedSeconds(state, T0 + second * 1000);
    }
    expect(last).toBe(oneTick);
    expect(last).toBe(3600);
  });

  it("survives a device sleeping for hours mid-session", () => {
    const state = start("goal-1", T0);
    // Laptop closed at 10:05, reopened at 13:05. No ticks fired at all.
    expect(elapsedSeconds(state, T0 + minutes(185))).toBe(185 * 60);
  });

  it("does not go backwards if the system clock jumps back", () => {
    const state = start("goal-1", T0);
    expect(elapsedSeconds(state, T0 - minutes(10))).toBe(0);
  });

  it("is unaffected by a DST transition, because segments are absolute ms", () => {
    // 2026-03-08 09:30Z -> 10:30Z crosses US spring-forward. The wall clock
    // jumps 01:59 -> 03:00 but only one real hour passes.
    const dstStart = Date.parse("2026-03-08T09:30:00.000Z");
    const state = start("goal-1", dstStart);
    expect(elapsedSeconds(state, Date.parse("2026-03-08T10:30:00.000Z"))).toBe(3600);
  });
});

describe("phases", () => {
  it("moves idle -> running -> paused -> running", () => {
    expect(phaseOf(undefined)).toBe("idle");

    const running = start("goal-1", T0);
    expect(phaseOf(running)).toBe("running");

    const paused = pause(running, T0 + minutes(10));
    expect(phaseOf(paused)).toBe("paused");

    const resumed = resume(paused, T0 + minutes(15));
    expect(phaseOf(resumed)).toBe("running");
  });

  it("treats a state with no segments as idle", () => {
    expect(phaseOf({ goalId: "g", segments: [], startedAt: T0, note: "" })).toBe("idle");
  });

  it("ignores a redundant pause or resume", () => {
    const running = start("goal-1", T0);
    const paused = pause(running, T0 + minutes(5));
    expect(pause(paused, T0 + minutes(6))).toBe(paused);

    const resumed = resume(paused, T0 + minutes(7));
    expect(resume(resumed, T0 + minutes(8))).toBe(resumed);
  });

  it("toggles", () => {
    const running = start("goal-1", T0);
    const paused = toggle(running, T0 + minutes(5));
    expect(phaseOf(paused)).toBe("paused");
    expect(phaseOf(toggle(paused, T0 + minutes(6)))).toBe("running");
  });
});

describe("pause and resume", () => {
  it("excludes paused time from the total", () => {
    // Focus 10m, pause 20m, focus 5m => 15m of focus, not 35m of wall clock.
    let state = start("goal-1", T0);
    state = pause(state, T0 + minutes(10));
    state = resume(state, T0 + minutes(30));
    expect(elapsedSeconds(state, T0 + minutes(35))).toBe(minutes(15) / 1000);
  });

  it("freezes the total while paused, however long the pause lasts", () => {
    let state = start("goal-1", T0);
    state = pause(state, T0 + minutes(10));
    expect(elapsedSeconds(state, T0 + minutes(11))).toBe(600);
    expect(elapsedSeconds(state, T0 + minutes(500))).toBe(600);
  });

  it("accumulates across many pause cycles", () => {
    let state = start("goal-1", T0);
    let cursor = T0;
    for (let i = 0; i < 5; i += 1) {
      cursor += minutes(6); // focus 6m
      state = pause(state, cursor);
      cursor += minutes(2); // pause 2m
      state = resume(state, cursor);
    }
    state = pause(state, cursor);
    expect(elapsedSeconds(state, cursor + minutes(100))).toBe(minutes(30) / 1000);
  });
});

describe("stop", () => {
  it("returns a start/end pair spanning only focused time", () => {
    let state = start("goal-1", T0);
    state = pause(state, T0 + minutes(10));
    state = resume(state, T0 + minutes(40));

    const result = stop(state, T0 + minutes(45));
    expect(result.seconds).toBe(minutes(15) / 1000);
    // end - start equals the focused duration, so the logged row is internally
    // consistent even though 45 minutes of wall clock elapsed.
    expect(result.end.getTime() - result.start.getTime()).toBe(minutes(15));
    expect(result.start.getTime()).toBe(T0);
  });

  it("C6 regression: keeps seconds rather than truncating to minutes", () => {
    const state = start("goal-1", T0);
    const result = stop(state, T0 + 1559 * 1000); // 25m59s
    expect(result.seconds).toBe(1559);
  });

  it("works on an already-paused timer", () => {
    let state = start("goal-1", T0);
    state = pause(state, T0 + minutes(10));
    expect(stop(state, T0 + minutes(90)).seconds).toBe(600);
  });

  it("carries the note through", () => {
    const state = start("goal-1", T0, "chapter 3");
    expect(stop(state, T0 + minutes(5)).note).toBe("chapter 3");
  });
});

describe("guardrails", () => {
  it("C12 regression: warns about a long session instead of silently deleting it", () => {
    // The old code removed any stored timer older than 24h with no warning.
    const warning = warningFor(LONG_SESSION_SECONDS + 60);
    expect(warning?.kind).toBe("long");
    expect(warning?.message).toMatch(/left running/);
  });

  it("refuses a session longer than a day, with an actionable message", () => {
    const warning = warningFor(MAX_SESSION_SECONDS + 1);
    expect(warning?.kind).toBe("too_long");
    expect(warning?.message).toMatch(/Trim it/);
  });

  it("C7 regression: flags a sub-minute session but still offers to log it", () => {
    const warning = warningFor(45);
    expect(warning?.kind).toBe("short");
    expect(warning?.message).toMatch(/Log it anyway/);
  });

  it("says nothing about an ordinary session", () => {
    expect(warningFor(1500)).toBeUndefined();
    expect(warningFor(60)).toBeUndefined();
    expect(warningFor(LONG_SESSION_SECONDS - 1)).toBeUndefined();
  });
});

describe("restore", () => {
  it("recovers a running timer after a crash and reports the real elapsed time", () => {
    const stored: TimerState = start("goal-1", T0);
    const { state, warning } = restore(stored, T0 + minutes(45));
    expect(state).toBe(stored);
    expect(warning).toBeUndefined();
    expect(elapsedSeconds(state, T0 + minutes(45))).toBe(minutes(45) / 1000);
  });

  it("keeps an overnight session and warns, rather than discarding it", () => {
    const stored = start("goal-1", T0);
    const { state, warning } = restore(stored, T0 + minutes(60 * 10));
    // The session is still there — this is the C12 fix.
    expect(state).toBeDefined();
    expect(warning?.kind).toBe("long");
  });

  it("keeps a session older than the old 24h TTL", () => {
    const stored = start("goal-1", T0);
    const { state, warning } = restore(stored, T0 + minutes(60 * 30));
    expect(state).toBeDefined(); // would have been deleted outright before
    expect(warning?.kind).toBe("too_long");
  });

  it("returns idle for nothing stored", () => {
    expect(restore(undefined, T0).state).toBeUndefined();
    expect(restore({ goalId: "g", segments: [], startedAt: T0, note: "" }, T0).state).toBeUndefined();
  });

  it("restores a paused timer without resuming it", () => {
    let stored = start("goal-1", T0);
    stored = pause(stored, T0 + minutes(10));
    const { state } = restore(stored, T0 + minutes(200));
    expect(phaseOf(state)).toBe("paused");
    expect(elapsedSeconds(state, T0 + minutes(200))).toBe(600);
  });
});

describe("clampAdjustment", () => {
  it("C3 regression: permits increasing the duration", () => {
    // Background throttling under-counted; the user must be able to correct
    // upward. The old handler rejected anything above the recorded time.
    expect(clampAdjustment(3600)).toBe(3600);
    expect(clampAdjustment(MAX_SESSION_SECONDS)).toBe(MAX_SESSION_SECONDS);
  });

  it("clamps to the storable range instead of erroring on stray input", () => {
    expect(clampAdjustment(-500)).toBe(0);
    expect(clampAdjustment(MAX_SESSION_SECONDS * 5)).toBe(MAX_SESSION_SECONDS);
    expect(clampAdjustment(Number.NaN)).toBe(0);
    expect(clampAdjustment(Infinity)).toBe(MAX_SESSION_SECONDS);
    expect(clampAdjustment(90.7)).toBe(91);
  });
});
