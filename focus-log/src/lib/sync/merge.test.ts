import { describe, expect, it } from "vitest";
import {
  compareVersions,
  mergeRecords,
  pickWinner,
  reduceLatest,
  supersededCount,
  visibleOnly,
  type Versioned,
} from "./merge";

interface Rec extends Versioned {
  id: string;
  value: string;
}

const byId = (r: Rec) => r.id;

function rec(id: string, value: string, updated_at: string, opts: Partial<Rec> = {}): Rec {
  return { id, value, updated_at, deleted: false, device_id: "dev-a", ...opts };
}

describe("compareVersions", () => {
  it("orders by instant", () => {
    const older = rec("a", "1", "2026-07-29T10:00:00.000Z");
    const newer = rec("a", "2", "2026-07-29T10:00:01.000Z");
    expect(compareVersions(newer, older)).toBeGreaterThan(0);
    expect(compareVersions(older, newer)).toBeLessThan(0);
  });

  it("compares instants, not strings, across differing ISO precision", () => {
    // As text, "…00:00Z" > "…00:00.000Z" because 'Z' (0x5A) > '.' (0x2E), so a
    // naive string compare would let a millisecond-less write beat an identical
    // moment — making the winner depend on which client wrote the row.
    const withMs = rec("a", "ms", "2026-07-29T10:00:00.000Z");
    const withoutMs = rec("a", "no-ms", "2026-07-29T10:00:00Z");
    expect("2026-07-29T10:00:00Z" > "2026-07-29T10:00:00.000Z").toBe(true); // the trap
    expect(compareVersions(withMs, withoutMs)).toBe(0); // same instant, same device
  });

  it("breaks an exact tie on device_id so all devices agree", () => {
    const a = rec("x", "from-a", "2026-07-29T10:00:00.000Z", { device_id: "dev-a" });
    const b = rec("x", "from-b", "2026-07-29T10:00:00.000Z", { device_id: "dev-b" });
    expect(compareVersions(b, a)).toBeGreaterThan(0);
    expect(compareVersions(a, b)).toBeLessThan(0);
    // Deterministic regardless of argument order.
    expect(pickWinner(a, b)).toBe(b);
    expect(pickWinner(b, a)).toBe(b);
  });

  it("treats a byte-identical row as an exact tie (idempotent retry)", () => {
    const original = rec("x", "v", "2026-07-29T10:00:00.000Z");
    const duplicate = { ...original };
    expect(compareVersions(original, duplicate)).toBe(0);
  });

  it("never lets an unparseable timestamp win", () => {
    const good = rec("x", "good", "2026-07-29T10:00:00.000Z");
    const bad = rec("x", "bad", "not a date");
    expect(compareVersions(bad, good)).toBeLessThan(0);
    expect(pickWinner(good, bad)).toBe(good);
    expect(pickWinner(bad, good)).toBe(good);
  });

  it("returns 0 when both timestamps are unparseable", () => {
    expect(compareVersions(rec("x", "a", "nope"), rec("x", "b", "also nope"))).toBe(0);
  });
});

describe("reduceLatest", () => {
  it("collapses an append-only log to the newest version per id", () => {
    const rows = [
      rec("a", "v1", "2026-07-29T10:00:00.000Z"),
      rec("b", "other", "2026-07-29T10:00:00.000Z"),
      rec("a", "v2", "2026-07-29T11:00:00.000Z"),
      rec("a", "v3", "2026-07-29T12:00:00.000Z"),
    ];
    const latest = reduceLatest(rows, byId);
    expect(latest.size).toBe(2);
    expect(latest.get("a")!.value).toBe("v3");
    expect(latest.get("b")!.value).toBe("other");
  });

  it("is order-independent", () => {
    const rows = [
      rec("a", "v1", "2026-07-29T10:00:00.000Z"),
      rec("a", "v3", "2026-07-29T12:00:00.000Z"),
      rec("a", "v2", "2026-07-29T11:00:00.000Z"),
    ];
    for (const permutation of [rows, [...rows].reverse(), [rows[1]!, rows[0]!, rows[2]!]]) {
      expect(reduceLatest(permutation, byId).get("a")!.value).toBe("v3");
    }
  });

  it("de-duplicates an idempotent retry to a single record", () => {
    const row = rec("a", "v1", "2026-07-29T10:00:00.000Z");
    // Same log_id, same updated_at: what a retried append produces.
    const latest = reduceLatest([row, { ...row }, { ...row }], byId);
    expect(latest.size).toBe(1);
    expect(latest.get("a")!.value).toBe("v1");
  });

  it("keeps a tombstone so the delete can propagate", () => {
    const rows = [
      rec("a", "v1", "2026-07-29T10:00:00.000Z"),
      rec("a", "v1", "2026-07-29T11:00:00.000Z", { deleted: true }),
    ];
    const latest = reduceLatest(rows, byId);
    expect(latest.get("a")!.deleted).toBe(true);
    expect(visibleOnly(latest.values())).toEqual([]);
  });

  it("lets a later undelete revive a tombstoned record", () => {
    const rows = [
      rec("a", "v1", "2026-07-29T11:00:00.000Z", { deleted: true }),
      rec("a", "revived", "2026-07-29T12:00:00.000Z", { deleted: false }),
    ];
    expect(visibleOnly(reduceLatest(rows, byId).values())).toHaveLength(1);
  });

  it("handles an empty input", () => {
    expect(reduceLatest([], byId).size).toBe(0);
  });
});

describe("mergeRecords", () => {
  it("adopts a record only the sheet has", () => {
    const remote = [rec("a", "from-other-device", "2026-07-29T10:00:00.000Z")];
    const result = mergeRecords([], remote, byId);
    expect(result.merged).toEqual(remote);
    expect(result.changedLocally).toEqual(remote);
    expect(result.changedRemotely).toEqual([]);
  });

  it("queues a record only we have", () => {
    const local = [rec("a", "made-offline", "2026-07-29T10:00:00.000Z")];
    const result = mergeRecords(local, [], byId);
    expect(result.merged).toEqual(local);
    expect(result.changedRemotely).toEqual(local);
    expect(result.changedLocally).toEqual([]);
  });

  it("lets an offline local edit win over a stale remote row", () => {
    // The core offline case: edited on this device at 12:00 while disconnected;
    // the sheet still holds the 10:00 version.
    const local = [rec("a", "edited-offline", "2026-07-29T12:00:00.000Z")];
    const remote = [rec("a", "stale", "2026-07-29T10:00:00.000Z")];
    const result = mergeRecords(local, remote, byId);
    expect(result.merged[0]!.value).toBe("edited-offline");
    expect(result.changedRemotely).toHaveLength(1);
    expect(result.changedLocally).toHaveLength(0);
  });

  it("accepts a newer remote edit from another device", () => {
    const local = [rec("a", "mine", "2026-07-29T10:00:00.000Z")];
    const remote = [rec("a", "theirs", "2026-07-29T12:00:00.000Z", { device_id: "dev-b" })];
    const result = mergeRecords(local, remote, byId);
    expect(result.merged[0]!.value).toBe("theirs");
    expect(result.changedLocally).toHaveLength(1);
    expect(result.changedRemotely).toHaveLength(0);
  });

  it("reports no change when both sides already agree", () => {
    const row = rec("a", "same", "2026-07-29T10:00:00.000Z");
    const result = mergeRecords([row], [{ ...row }], byId);
    expect(result.merged).toHaveLength(1);
    expect(result.changedLocally).toEqual([]);
    expect(result.changedRemotely).toEqual([]);
  });

  it("propagates a remote delete", () => {
    const local = [rec("a", "v", "2026-07-29T10:00:00.000Z")];
    const remote = [rec("a", "v", "2026-07-29T11:00:00.000Z", { deleted: true })];
    const result = mergeRecords(local, remote, byId);
    expect(result.changedLocally[0]!.deleted).toBe(true);
    expect(visibleOnly(result.merged)).toEqual([]);
  });

  it("propagates a local delete made offline", () => {
    const local = [rec("a", "v", "2026-07-29T11:00:00.000Z", { deleted: true })];
    const remote = [rec("a", "v", "2026-07-29T10:00:00.000Z")];
    const result = mergeRecords(local, remote, byId);
    expect(result.changedRemotely[0]!.deleted).toBe(true);
  });

  it("resolves a simultaneous two-device edit identically on both devices", () => {
    // Same instant, different devices — the hard case. Both must converge.
    const fromA = rec("a", "A-version", "2026-07-29T10:00:00.000Z", { device_id: "dev-a" });
    const fromB = rec("a", "B-version", "2026-07-29T10:00:00.000Z", { device_id: "dev-b" });

    const asSeenOnA = mergeRecords([fromA], [fromB], byId);
    const asSeenOnB = mergeRecords([fromB], [fromA], byId);

    expect(asSeenOnA.merged[0]!.value).toBe("B-version");
    expect(asSeenOnB.merged[0]!.value).toBe("B-version");
    expect(asSeenOnA.merged).toEqual(asSeenOnB.merged);
  });

  it("is commutative for the merged set across random orderings", () => {
    // Property check: shuffling either side must not change the outcome.
    const ids = ["a", "b", "c", "d", "e"];
    const devices = ["dev-a", "dev-b", "dev-c"];
    const build = (seed: number) =>
      ids.flatMap((id, i) =>
        Array.from({ length: 3 }, (_, v) => {
          const minute = (seed * 7 + i * 3 + v * 5) % 60;
          return rec(id, `${id}-${v}`, `2026-07-29T10:${String(minute).padStart(2, "0")}:00.000Z`, {
            device_id: devices[(i + v + seed) % devices.length]!,
            deleted: (seed + i + v) % 5 === 0,
          });
        }),
      );

    const left = build(1);
    const right = build(2);

    const normalise = (records: Rec[]) =>
      [...records].sort((x, y) => x.id.localeCompare(y.id)).map((r) => `${r.id}:${r.value}:${r.deleted}`);

    const forward = mergeRecords(left, right, byId);
    const backward = mergeRecords(right, left, byId);
    expect(normalise(forward.merged)).toEqual(normalise(backward.merged));

    // And shuffling within a side changes nothing.
    const shuffled = [...left].reverse();
    const reshuffled = mergeRecords(shuffled, [...right].reverse(), byId);
    expect(normalise(reshuffled.merged)).toEqual(normalise(forward.merged));
  });

  it("converges after a second round-trip (idempotent merge)", () => {
    const local = [rec("a", "mine", "2026-07-29T12:00:00.000Z")];
    const remote = [rec("a", "theirs", "2026-07-29T10:00:00.000Z")];
    const first = mergeRecords(local, remote, byId);
    // Re-merging the result against the same remote must be a no-op.
    const second = mergeRecords(first.merged, remote, byId);
    expect(second.merged).toEqual(first.merged);
    const third = mergeRecords(first.merged, first.merged, byId);
    expect(third.changedLocally).toEqual([]);
    expect(third.changedRemotely).toEqual([]);
  });
});

describe("supersededCount", () => {
  it("counts rows that compaction would remove", () => {
    const rows = [
      rec("a", "v1", "2026-07-29T10:00:00.000Z"),
      rec("a", "v2", "2026-07-29T11:00:00.000Z"),
      rec("a", "v3", "2026-07-29T12:00:00.000Z"),
      rec("b", "only", "2026-07-29T10:00:00.000Z"),
    ];
    expect(supersededCount(rows, byId)).toBe(2);
  });

  it("is zero for an already-compact set", () => {
    expect(supersededCount([rec("a", "v", "2026-07-29T10:00:00.000Z")], byId)).toBe(0);
  });
});
