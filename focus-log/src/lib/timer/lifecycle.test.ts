import { describe, expect, it } from "vitest";
import { start, pause, resume, type TimerState } from "./engine";
import {
  closedActive,
  finalizedSession,
  reconcileActive,
  runningActive,
  timerFromActive,
} from "./lifecycle";
import type { ActiveTimer } from "../sheets/schema";

const ctx = { logId: "log-abc", deviceId: "dev-1", now: 0 };

/** A timer started at 0, run 10 min, paused 5 min, resumed, still running. */
function pausedThenRunning(): TimerState {
  let s = start("g1", 0, "note text");
  s = pause(s, 600_000); // 10 min in
  s = resume(s, 900_000); // resumes at 15 min
  return s;
}

describe("finalizedSession", () => {
  it("logs focused time only, excluding the pause, under the reserved log_id", () => {
    const s = pausedThenRunning();
    const session = finalizedSession(s, { ...ctx, now: 1_200_000, tz: "UTC" });
    // 10 min (first segment) + 5 min (900k→1.2M) = 15 min focused; the 5-min pause is excluded.
    expect(session.duration_seconds).toBe(900);
    expect(session.log_id).toBe("log-abc");
    expect(session.source).toBe("timer");
    // end = start + focused duration, so the logged span equals focused time.
    expect(session.start_utc).toBe("1970-01-01T00:00:00.000Z");
    expect(session.end_utc).toBe("1970-01-01T00:15:00.000Z");
  });

  it("gives two devices ending the same timer the SAME log_id (so LWW collapses them)", () => {
    const s = pausedThenRunning();
    const a = finalizedSession(s, { logId: "log-abc", deviceId: "mac", now: 1_200_000, tz: "UTC" });
    const b = finalizedSession(s, {
      logId: "log-abc",
      deviceId: "phone",
      now: 1_260_000,
      tz: "UTC",
    });
    // Different end times / devices, but one id — the reducer keeps a single session.
    expect(a.log_id).toBe(b.log_id);
    expect(a.duration_seconds).not.toBe(b.duration_seconds);
    expect(a.device_id).not.toBe(b.device_id);
  });
});

describe("runningActive / closedActive", () => {
  it("publishes the live segments without a tombstone", () => {
    const s = pausedThenRunning();
    const active = runningActive(s, { ...ctx, now: 1_000_000 });
    expect(active.deleted).toBe(false);
    expect(active.segments).toEqual(s.segments);
    expect(active.log_id).toBe("log-abc");
    expect(active.updated_at).toBe("1970-01-01T00:16:40.000Z");
  });

  it("closedActive is a tombstone that still carries the id and segments", () => {
    const s = pausedThenRunning();
    const closed = closedActive(s, { ...ctx, now: 1_000_000 });
    expect(closed.deleted).toBe(true);
    expect(closed.log_id).toBe("log-abc");
    expect(closed.segments).toEqual(s.segments);
  });
});

describe("timerFromActive", () => {
  it("rebuilds a controllable timer, recovering startedAt from the first segment", () => {
    const s = pausedThenRunning();
    const rebuilt = timerFromActive(runningActive(s, ctx));
    expect(rebuilt).toEqual(s);
    expect(rebuilt.startedAt).toBe(s.segments[0]!.start);
  });
});

describe("reconcileActive", () => {
  function active(logId: string, startedAt: number, opts: Partial<ActiveTimer> = {}): ActiveTimer {
    return {
      log_id: logId,
      goal_id: "g1",
      segments: [{ start: startedAt, end: null }],
      note: "",
      updated_at: new Date(startedAt).toISOString(),
      deleted: false,
      device_id: "dev-a",
      ...opts,
    };
  }

  it("stays idle when nothing is running anywhere", () => {
    expect(reconcileActive(undefined, [])).toEqual({ local: undefined, changed: false });
  });

  it("adopts a timer running on another device when idle here", () => {
    const remote = active("L1", 1000, { device_id: "dev-mac" });
    const r = reconcileActive(undefined, [remote]);
    expect(r).toEqual({ local: remote, changed: true });
  });

  it("ignores a tombstoned remote timer when idle", () => {
    const r = reconcileActive(undefined, [active("L1", 1000, { deleted: true })]);
    expect(r).toEqual({ local: undefined, changed: false });
  });

  it("clears the local timer when another device stopped it (remote tombstone)", () => {
    const local = active("L1", 1000);
    const remoteClosed = active("L1", 1000, {
      deleted: true,
      updated_at: "2026-02-02T00:00:00.000Z",
    });
    expect(reconcileActive(local, [remoteClosed])).toEqual({ local: undefined, changed: true });
  });

  it("adopts a newer version of my own timer (paused on another device)", () => {
    const local = active("L1", 1000, { segments: [{ start: 1000, end: null }] });
    const pausedRemote = active("L1", 1000, {
      segments: [{ start: 1000, end: 5000 }], // paused elsewhere
      updated_at: "2026-02-02T00:00:00.000Z",
      device_id: "dev-phone",
    });
    const r = reconcileActive(local, [pausedRemote]);
    expect(r.local).toEqual(pausedRemote);
    expect(r.changed).toBe(true);
    expect(r.closeLogId).toBeUndefined();
  });

  it("keeps my not-yet-synced timer (remote has no record of it)", () => {
    const local = active("L1", 1000);
    expect(reconcileActive(local, [])).toEqual({ local, changed: false });
  });

  it("keeps mine when it started earliest, even if a later timer exists remotely", () => {
    const local = active("mine", 1000);
    const laterOther = active("other", 5000, { device_id: "dev-x" });
    const r = reconcileActive(local, [laterOther]);
    expect(r.local).toBe(local);
    expect(r.changed).toBe(false);
    expect(r.closeLogId).toBeUndefined();
  });

  it("yields to an earlier concurrent start and auto-closes mine (no session logged)", () => {
    const earlierOther = active("aaa", 1000, { device_id: "dev-mac" });
    const local = active("zzz", 3000, { device_id: "dev-phone" });
    const r = reconcileActive(local, [earlierOther]);
    expect(r.local).toEqual(earlierOther);
    expect(r.closeLogId).toBe("zzz");
    expect(r.changed).toBe(true);
  });

  it("breaks a started_at tie by log_id so both devices agree", () => {
    const local = active("bbb", 2000);
    const other = active("aaa", 2000, { device_id: "dev-x" });
    const r = reconcileActive(local, [other]);
    // "aaa" < "bbb", so the other wins deterministically and mine is closed.
    expect(r.local).toEqual(other);
    expect(r.closeLogId).toBe("bbb");
  });
});
