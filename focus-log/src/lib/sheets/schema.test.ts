import { describe, expect, it } from "vitest";
import { columnLetter, fullRange, headerRow, GOAL_COLUMNS, SESSION_COLUMNS } from "./columns";
import { toBoolean, toNumber } from "./cells";
import {
  goalToRow,
  parseGoalRows,
  parseMetaRows,
  parseSessionRows,
  sessionToRow,
  type Goal,
  type Session,
} from "./schema";

const SESSION_HEADER = headerRow(SESSION_COLUMNS);
const GOAL_HEADER = headerRow(GOAL_COLUMNS);

const goal: Goal = {
  goal_id: "11111111-1111-4111-8111-111111111111",
  title: "Deep work",
  color: "#4caf50",
  weekly_target_minutes: 600,
  sort_order: 1,
  status: "active",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-29T10:00:00.000Z",
  deleted: false,
  device_id: "dev-a",
};

const session: Session = {
  log_id: "22222222-2222-4222-8222-222222222222",
  goal_id: goal.goal_id,
  start_utc: "2026-07-29T10:00:00.000Z",
  end_utc: "2026-07-29T10:25:59.000Z",
  duration_seconds: 1559,
  local_date: "2026-07-29",
  tz: "Asia/Singapore",
  note: "",
  source: "timer",
  updated_at: "2026-07-29T10:26:00.000Z",
  deleted: false,
  device_id: "dev-a",
};

describe("column layout", () => {
  it("maps indices to A1 letters", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(11)).toBe("L");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
    expect(() => columnLetter(-1)).toThrow(RangeError);
  });

  it("C13 regression: the read range covers every written column", () => {
    // The old code wrote logs!A:C but read logs!A:D, so duration was never
    // written by the app at all. One derived range makes that impossible.
    expect(fullRange("sessions", SESSION_COLUMNS)).toBe("sessions!A:L");
    expect(fullRange("goals", GOAL_COLUMNS)).toBe("goals!A:J");
    expect(sessionToRow(session)).toHaveLength(SESSION_COLUMNS.length);
    expect(goalToRow(goal)).toHaveLength(GOAL_COLUMNS.length);
  });
});

describe("cell coercion", () => {
  it("C8 regression: locale-grouped numbers survive", () => {
    // parseInt("1,234") is 1 — this silently collapsed goal totals past 1000.
    expect(toNumber("1,234")).toBe(1234);
    expect(toNumber(1234)).toBe(1234);
    expect(toNumber("1234")).toBe(1234);
  });

  it("C9 regression: non-numeric values return undefined, never NaN", () => {
    // parseInt("health") is NaN, and NaN === NaN is false, which made every
    // chart silently render empty.
    expect(toNumber("health")).toBeUndefined();
    expect(toNumber("")).toBeUndefined();
    expect(toNumber(null)).toBeUndefined();
    expect(toNumber(undefined)).toBeUndefined();
    expect(toNumber("12abc")).toBeUndefined();
    expect(toNumber(Number.NaN)).toBeUndefined();
    expect(toNumber(Infinity)).toBeUndefined();
  });

  it("accepts every shape a tombstone can arrive in", () => {
    for (const truthy of [true, "TRUE", "true", "True", 1, "1", "yes"]) {
      expect(toBoolean(truthy)).toBe(true);
    }
    for (const falsy of [false, "FALSE", "false", 0, "0", "", null, undefined, "anything"]) {
      expect(toBoolean(falsy)).toBe(false);
    }
  });
});

describe("session rows", () => {
  it("round-trips losslessly", () => {
    const { records, failures } = parseSessionRows([SESSION_HEADER, sessionToRow(session)]);
    expect(failures).toEqual([]);
    expect(records).toEqual([session]);
  });

  it("C14 regression: a short row (trailing blanks omitted by Sheets) still parses", () => {
    // Sheets truncates a *suffix* of empty cells, so the optional trailing
    // columns (deleted, device_id) can simply be absent from the array.
    const short = [
      session.log_id,
      session.goal_id,
      session.start_utc,
      session.end_utc,
      session.duration_seconds,
      session.local_date,
      session.tz,
      "", // note
      "", // source -> defaults to "timer"
      session.updated_at,
    ];
    const { records, failures } = parseSessionRows([SESSION_HEADER, short]);
    expect(failures).toEqual([]);
    expect(records[0]).toMatchObject({
      log_id: session.log_id,
      note: "",
      source: "timer",
      deleted: false,
      device_id: "",
    });
  });

  it("rejects a row with no updated_at, because it cannot be merged", () => {
    // updated_at is the last-write-wins key. There is no safe default: guessing
    // one would let a stale row silently win a conflict.
    const noTimestamp = sessionToRow(session);
    noTimestamp[9] = "";
    const { records, failures } = parseSessionRows([SESSION_HEADER, noTimestamp]);
    expect(records).toEqual([]);
    expect(failures[0]!.problems.join(" ")).toContain("updated_at");
  });

  it("skips wholly blank padding rows without reporting failures", () => {
    const { records, failures } = parseSessionRows([
      SESSION_HEADER,
      sessionToRow(session),
      ["", "", "", null, undefined],
      [],
    ]);
    expect(records).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it("reports a malformed row instead of yielding a garbage record", () => {
    const bad = sessionToRow({ ...session, duration_seconds: 10 });
    bad[2] = "01/15/2025 14:30:00"; // the old ambiguous format
    const { records, failures } = parseSessionRows([SESSION_HEADER, bad]);
    expect(records).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.sheetRow).toBe(2);
    expect(failures[0]!.problems.join(" ")).toContain("start_utc");
  });

  it("rejects a session whose end precedes its start", () => {
    const backwards = sessionToRow({
      ...session,
      start_utc: "2026-07-29T11:00:00.000Z",
      end_utc: "2026-07-29T10:00:00.000Z",
    });
    const { records, failures } = parseSessionRows([SESSION_HEADER, backwards]);
    expect(records).toEqual([]);
    expect(failures[0]!.problems.join(" ")).toContain("end_utc");
  });

  it("rejects an absurd duration rather than trusting the sheet", () => {
    const tooLong = sessionToRow({ ...session, duration_seconds: 99 * 3600 });
    expect(parseSessionRows([SESSION_HEADER, tooLong]).failures).toHaveLength(1);
  });

  it("keeps a zero-second duration parseable (it is real data, just degenerate)", () => {
    const zero = sessionToRow({
      ...session,
      end_utc: session.start_utc,
      duration_seconds: 0,
    });
    expect(parseSessionRows([SESSION_HEADER, zero]).records).toHaveLength(1);
  });

  it("reports the correct sheet row number for a later failure", () => {
    const bad = sessionToRow(session);
    bad[0] = ""; // missing log_id
    const { failures } = parseSessionRows([SESSION_HEADER, sessionToRow(session), bad]);
    expect(failures[0]!.sheetRow).toBe(3);
  });
});

describe("goal rows", () => {
  it("round-trips losslessly", () => {
    const { records, failures } = parseGoalRows([GOAL_HEADER, goalToRow(goal)]);
    expect(failures).toEqual([]);
    expect(records).toEqual([goal]);
  });

  it("C14 regression: a goal with no logged time is still visible", () => {
    // The old home page filtered on `row[0] && row[1]` against a formula-driven
    // summary tab, so a brand-new goal with no sessions vanished entirely.
    // Goals no longer carry a total at all, so this cannot recur.
    const fresh = goalToRow({ ...goal, weekly_target_minutes: 0 });
    const { records } = parseGoalRows([GOAL_HEADER, fresh]);
    expect(records).toHaveLength(1);
    expect(records[0]!.weekly_target_minutes).toBe(0);
  });

  it("applies defaults for blank optional columns", () => {
    const { records } = parseGoalRows([
      GOAL_HEADER,
      [goal.goal_id, "Untitled", "", "", "", "", goal.created_at, goal.updated_at],
    ]);
    expect(records[0]).toMatchObject({
      color: "#4caf50",
      weekly_target_minutes: 0,
      sort_order: 0,
      status: "active",
      deleted: false,
    });
  });

  it("rejects an unknown status", () => {
    const bad = goalToRow(goal);
    bad[5] = "paused";
    expect(parseGoalRows([GOAL_HEADER, bad]).failures).toHaveLength(1);
  });

  it("preserves a tombstoned goal so the delete can propagate", () => {
    const { records } = parseGoalRows([GOAL_HEADER, goalToRow({ ...goal, deleted: true })]);
    expect(records[0]!.deleted).toBe(true);
  });
});

describe("meta rows", () => {
  it("reads key/value pairs", () => {
    expect(
      parseMetaRows([
        ["key", "value"],
        ["schema_version", "1"],
        ["created_by", "focus-log"],
        ["", "orphan value"],
      ]),
    ).toEqual({ schema_version: "1", created_by: "focus-log" });
  });

  it("tolerates an empty sheet", () => {
    expect(parseMetaRows([])).toEqual({});
    expect(parseMetaRows(undefined)).toEqual({});
    expect(parseMetaRows(null)).toEqual({});
  });
});
