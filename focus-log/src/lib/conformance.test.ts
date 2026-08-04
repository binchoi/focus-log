/**
 * Cross-core conformance: the web core must agree with the Wear OS (Kotlin) core
 * on every rule the server-free last-write-wins protocol depends on. Both suites
 * load the *same* vectors in /conformance; the Kotlin twin is
 * focus-log-wear/core/.../ConformanceTest.kt.
 *
 * If this drifts from the Kotlin core, two devices can disagree on which edit
 * won or how long a session was — the exact class of bug the vectors exist to
 * catch. Keep the vectors as the shared source of truth; change both cores
 * together.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { elapsedSeconds, type Segment, type TimerState } from "./timer/engine";
import { compareVersions, pickWinner, type Versioned } from "./sync/merge";
import { decodeSegments, encodeSegments } from "./sheets/schema";
import {
  closedActive,
  finalizedSession,
  reconcileActive,
  runningActive,
  timerFromActive,
} from "./timer/lifecycle";
import type { ActiveTimer } from "./sheets/schema";

function loadVectors<T>(file: string): T {
  const path = fileURLToPath(new URL(`../../../conformance/${file}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** A [startMs, endMs|null] pair as stored in the vectors. */
type SegPair = [number, number | null];
const toSegments = (pairs: SegPair[]): Segment[] => pairs.map(([start, end]) => ({ start, end }));

describe("conformance: elapsedSeconds", () => {
  const { cases } = loadVectors<{
    cases: { name: string; segments: SegPair[]; now: number; expectedSeconds: number }[];
  }>("elapsed.json");

  it.each(cases)("$name", ({ segments, now, expectedSeconds }) => {
    const state = { goalId: "g", segments: toSegments(segments), startedAt: 0, note: "" };
    expect(elapsedSeconds(state, now)).toBe(expectedSeconds);
  });
});

describe("conformance: last-write-wins", () => {
  type Rec = Versioned & { id: string };
  const { cases } = loadVectors<{
    cases: { name: string; a: Rec; b: Rec; winner: "a" | "b" }[];
  }>("lww.json");

  it.each(cases)("$name", ({ a, b, winner }) => {
    const ra: Rec = { ...a, deleted: false };
    const rb: Rec = { ...b, deleted: false };
    const cmp = compareVersions(ra, rb);
    expect(pickWinner(ra, rb).id).toBe(winner === "a" ? "A" : "B");

    if (cmp !== 0) {
      // A real winner is order-independent: the same record wins either way.
      expect(pickWinner(rb, ra).id).toBe(winner === "a" ? "A" : "B");
      expect(winner === "b" ? cmp < 0 : cmp > 0).toBe(true);
    } else {
      // An exact tie is expressed as winner "a", and pickWinner deterministically
      // returns its first argument (so the swap returns "B").
      expect(winner).toBe("a");
      expect(pickWinner(rb, ra).id).toBe("B");
    }
  });
});

describe("conformance: segments codec", () => {
  const { cases, invalidEncoded } = loadVectors<{
    cases: { name: string; segments: SegPair[]; encoded: string }[];
    invalidEncoded: string[];
  }>("segments-codec.json");

  it.each(cases)("$name", ({ segments, encoded }) => {
    expect(encodeSegments(toSegments(segments))).toBe(encoded);
    expect(decodeSegments(encoded)).toEqual(toSegments(segments));
  });

  it.each(invalidEncoded)("rejects %j", (bad) => {
    expect(() => decodeSegments(bad)).toThrow();
  });
});

describe("conformance: active-timer lifecycle mapping", () => {
  interface MappingCase {
    name: string;
    input: {
      logId: string;
      goalId: string;
      segments: SegPair[];
      note: string;
      tz: string;
      deviceId: string;
      now: number;
    };
    finalizedSession: Record<string, unknown>;
    activeEncodedSegments: string;
    activeUpdatedAt: string;
  }
  const { cases } = loadVectors<{ cases: MappingCase[] }>("active-mapping.json");

  it.each(cases)(
    "$name",
    ({ input, finalizedSession: expected, activeEncodedSegments, activeUpdatedAt }) => {
      const segments = toSegments(input.segments);
      const state: TimerState = {
        goalId: input.goalId,
        segments,
        startedAt: segments[0]?.start ?? 0,
        note: input.note,
      };
      const ctx = { logId: input.logId, deviceId: input.deviceId, now: input.now };

      expect(finalizedSession(state, { ...ctx, tz: input.tz })).toEqual(expected);

      const active = runningActive(state, ctx);
      expect(encodeSegments(active.segments)).toBe(activeEncodedSegments);
      expect(active.updated_at).toBe(activeUpdatedAt);
      expect(active.deleted).toBe(false);
      expect(active.log_id).toBe(input.logId);
      expect(closedActive(state, ctx).deleted).toBe(true);

      // Round-trip: a device adopting the published row rebuilds the same timer.
      expect(timerFromActive(active)).toEqual(state);
    },
  );
});

describe("conformance: reconcileActive", () => {
  interface ActiveJson {
    log_id: string;
    goal_id: string;
    segments: SegPair[];
    note: string;
    updated_at: string;
    deleted: boolean;
    device_id: string;
  }
  const toActive = (a: ActiveJson | null): ActiveTimer | undefined =>
    a ? { ...a, segments: toSegments(a.segments) } : undefined;

  interface ReconcileCase {
    name: string;
    local: ActiveJson | null;
    remote: ActiveJson[];
    expected: { local: ActiveJson | null; closeLogId: string | null; changed: boolean };
  }
  const { cases } = loadVectors<{ cases: ReconcileCase[] }>("reconcile.json");

  it.each(cases)("$name", ({ local, remote, expected }) => {
    const result = reconcileActive(toActive(local), remote.map(toActive) as ActiveTimer[]);
    expect(result.local).toEqual(toActive(expected.local));
    expect(result.closeLogId ?? null).toBe(expected.closeLogId);
    expect(result.changed).toBe(expected.changed);
  });
});
