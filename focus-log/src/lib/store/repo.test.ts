import { beforeEach, describe, expect, it } from "vitest";
import { FocusLogDb, setDbForTests } from "./db";
import {
  createGoal,
  deleteGoal,
  deleteSession,
  listGoals,
  listSessions,
  logSession,
  pendingCount,
  totalsByGoal,
  updateGoal,
  updateSession,
} from "./repo";
import { newId } from "./ids";

let dbCounter = 0;
let database: FocusLogDb;
let clock = Date.parse("2026-07-29T10:00:00.000Z");

const context = () => ({
  database,
  now: () => new Date(clock),
  deviceId: () => "dev-test",
  timeZone: () => "Asia/Singapore",
});

const tick = (ms: number) => (clock += ms);

beforeEach(async () => {
  dbCounter += 1;
  database = new FocusLogDb(`focus-log-repo-${dbCounter}`);
  setDbForTests(database);
  await database.open();
  clock = Date.parse("2026-07-29T10:00:00.000Z");
});

describe("newId", () => {
  it("produces distinct v4 uuids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe("goal CRUD", () => {
  it("creates a goal that is immediately visible with no logged time", async () => {
    // The old app derived the goal list from a formula-driven summary tab and
    // filtered on a truthy total, so a brand-new goal was invisible (C14).
    const goal = await createGoal({ title: "  Deep work  " }, context());
    expect(goal.title).toBe("Deep work"); // trimmed
    expect(goal.status).toBe("active");

    const goals = await listGoals(context());
    expect(goals).toHaveLength(1);
    expect(goals[0]!.goal_id).toBe(goal.goal_id);
  });

  it("renames a goal and bumps updated_at without touching created_at", async () => {
    const goal = await createGoal({ title: "Old name" }, context());
    tick(60_000);
    const renamed = await updateGoal(goal.goal_id, { title: "New name" }, context());

    expect(renamed.title).toBe("New name");
    expect(renamed.created_at).toBe(goal.created_at);
    expect(Date.parse(renamed.updated_at)).toBeGreaterThan(Date.parse(goal.updated_at));
  });

  it("sets a weekly target", async () => {
    const goal = await createGoal({ title: "Reading", weekly_target_minutes: 300 }, context());
    expect(goal.weekly_target_minutes).toBe(300);
    const updated = await updateGoal(goal.goal_id, { weekly_target_minutes: 600 }, context());
    expect(updated.weekly_target_minutes).toBe(600);
  });

  it("soft-deletes so the tombstone can propagate to other devices", async () => {
    const goal = await createGoal({ title: "Temporary" }, context());
    tick(1000);
    await deleteGoal(goal.goal_id, context());

    expect(await listGoals(context())).toHaveLength(0);
    // The row is retained, tombstoned — not physically removed.
    const stored = await database.goals.get(goal.goal_id);
    expect(stored!.deleted).toBe(true);
    expect(stored!.status).toBe("archived");
  });

  it("orders by sort_order then title", async () => {
    await createGoal({ title: "Zeta", sort_order: 1 }, context());
    await createGoal({ title: "Alpha", sort_order: 2 }, context());
    await createGoal({ title: "Beta", sort_order: 1 }, context());

    expect((await listGoals(context())).map((g) => g.title)).toEqual(["Beta", "Zeta", "Alpha"]);
  });

  it("rejects an unknown goal id", async () => {
    await expect(updateGoal("nope", { title: "x" }, context())).rejects.toThrow(/No such goal/);
  });

  it("rejects an empty title", async () => {
    await expect(createGoal({ title: "   " }, context())).rejects.toThrow();
  });
});

describe("session CRUD", () => {
  it("logs, edits and deletes a session entirely in-app", async () => {
    // All three of these previously required opening the spreadsheet by hand.
    const goal = await createGoal({ title: "Writing" }, context());
    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:45:00.000Z"),
        note: "chapter 3",
      },
      context(),
    );
    expect(session.duration_seconds).toBe(2700);
    expect(session.note).toBe("chapter 3");

    tick(1000);
    const edited = await updateSession(session.log_id, { duration_seconds: 3600 }, context());
    expect(edited.duration_seconds).toBe(3600);
    // end_utc follows the new duration so the row stays self-consistent.
    expect(edited.end_utc).toBe("2026-07-29T10:00:00.000Z");

    tick(1000);
    await deleteSession(session.log_id, context());
    expect(await listSessions({}, context())).toHaveLength(0);
    expect((await database.sessions.get(session.log_id))!.deleted).toBe(true);
  });

  it("backfills a past session with source=manual", async () => {
    const goal = await createGoal({ title: "Gym" }, context());
    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-20T01:00:00.000Z"),
        end: new Date("2026-07-20T02:00:00.000Z"),
        source: "manual",
      },
      context(),
    );
    expect(session.source).toBe("manual");
    // 01:00Z is 09:00 in Singapore on the same day.
    expect(session.local_date).toBe("2026-07-20");
  });

  it("moves a session to a different goal", async () => {
    const from = await createGoal({ title: "From" }, context());
    const to = await createGoal({ title: "To" }, context());
    const session = await logSession(
      {
        goal_id: from.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:30:00.000Z"),
      },
      context(),
    );
    tick(1000);
    const moved = await updateSession(session.log_id, { goal_id: to.goal_id }, context());
    expect(moved.goal_id).toBe(to.goal_id);
    expect(await listSessions({ goalId: to.goal_id }, context())).toHaveLength(1);
    expect(await listSessions({ goalId: from.goal_id }, context())).toHaveLength(0);
  });

  it("recomputes local_date when the start time moves across a day boundary", async () => {
    const goal = await createGoal({ title: "Shifting" }, context());
    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T15:00:00.000Z"), // 23:00 SGT on the 29th
        end: new Date("2026-07-29T15:30:00.000Z"),
      },
      context(),
    );
    expect(session.local_date).toBe("2026-07-29");

    tick(1000);
    const moved = await updateSession(
      session.log_id,
      { start_utc: "2026-07-29T16:30:00.000Z" }, // 00:30 SGT on the 30th
      context(),
    );
    expect(moved.local_date).toBe("2026-07-30");
  });

  it("rejects unknown session ids", async () => {
    await expect(updateSession("nope", { note: "x" }, context())).rejects.toThrow(/No such session/);
    await expect(deleteSession("nope", context())).rejects.toThrow(/No such session/);
  });

  it("rejects an out-of-range edit", async () => {
    const goal = await createGoal({ title: "Bounded" }, context());
    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:30:00.000Z"),
      },
      context(),
    );
    await expect(
      updateSession(session.log_id, { duration_seconds: 99 * 3600 }, context()),
    ).rejects.toThrow(/out of range/);
    await expect(updateSession(session.log_id, { duration_seconds: -1 }, context())).rejects.toThrow(
      /out of range/,
    );
  });
});

describe("queries", () => {
  it("totals seconds per goal locally, not from a sheet formula (C13)", async () => {
    const a = await createGoal({ title: "A" }, context());
    const b = await createGoal({ title: "B" }, context());

    await logSession(
      { goal_id: a.goal_id, start: new Date("2026-07-29T01:00:00.000Z"), end: new Date("2026-07-29T02:00:00.000Z") },
      context(),
    );
    await logSession(
      { goal_id: a.goal_id, start: new Date("2026-07-29T03:00:00.000Z"), end: new Date("2026-07-29T03:30:00.000Z") },
      context(),
    );
    await logSession(
      { goal_id: b.goal_id, start: new Date("2026-07-29T04:00:00.000Z"), end: new Date("2026-07-29T04:10:00.000Z") },
      context(),
    );

    const totals = await totalsByGoal({}, context());
    expect(totals.get(a.goal_id)).toBe(5400);
    expect(totals.get(b.goal_id)).toBe(600);
  });

  it("C8 regression: totals stay exact past 1000 minutes", async () => {
    // parseInt("1,234") was 1, so a goal's total silently collapsed once it
    // passed 1000 minutes. Nothing is parsed from a formatted string now.
    const goal = await createGoal({ title: "Big" }, context());
    for (let day = 1; day <= 25; day += 1) {
      const d = String(day).padStart(2, "0");
      await logSession(
        {
          goal_id: goal.goal_id,
          start: new Date(`2026-07-${d}T01:00:00.000Z`),
          end: new Date(`2026-07-${d}T02:00:00.000Z`),
        },
        context(),
      );
    }
    const totals = await totalsByGoal({}, context());
    expect(totals.get(goal.goal_id)).toBe(25 * 3600); // 1500 minutes
  });

  it("filters sessions by goal and local date range", async () => {
    const goal = await createGoal({ title: "Ranged" }, context());
    for (const day of ["10", "15", "20"]) {
      await logSession(
        {
          goal_id: goal.goal_id,
          start: new Date(`2026-07-${day}T01:00:00.000Z`),
          end: new Date(`2026-07-${day}T02:00:00.000Z`),
        },
        context(),
      );
    }

    expect(await listSessions({ from: "2026-07-14", to: "2026-07-21" }, context())).toHaveLength(2);
    expect(await listSessions({ from: "2026-07-16" }, context())).toHaveLength(1);
    expect(await listSessions({ to: "2026-07-11" }, context())).toHaveLength(1);
    expect(await listSessions({ goalId: "other" }, context())).toHaveLength(0);
  });

  it("returns sessions newest first", async () => {
    const goal = await createGoal({ title: "Ordered" }, context());
    for (const hour of ["01", "05", "03"]) {
      await logSession(
        {
          goal_id: goal.goal_id,
          start: new Date(`2026-07-29T${hour}:00:00.000Z`),
          end: new Date(`2026-07-29T${hour}:30:00.000Z`),
        },
        context(),
      );
    }
    const starts = (await listSessions({}, context())).map((s) => s.start_utc.slice(11, 13));
    expect(starts).toEqual(["05", "03", "01"]);
  });

  it("excludes tombstoned sessions from totals", async () => {
    const goal = await createGoal({ title: "Partly deleted" }, context());
    const keep = await logSession(
      { goal_id: goal.goal_id, start: new Date("2026-07-29T01:00:00.000Z"), end: new Date("2026-07-29T02:00:00.000Z") },
      context(),
    );
    const drop = await logSession(
      { goal_id: goal.goal_id, start: new Date("2026-07-29T03:00:00.000Z"), end: new Date("2026-07-29T04:00:00.000Z") },
      context(),
    );
    tick(1000);
    await deleteSession(drop.log_id, context());

    expect((await totalsByGoal({}, context())).get(goal.goal_id)).toBe(3600);
    expect((await listSessions({}, context()))[0]!.log_id).toBe(keep.log_id);
  });

  it("counts pending outbox ops for the sync badge", async () => {
    expect(await pendingCount(context())).toBe(0);
    const goal = await createGoal({ title: "Queued" }, context());
    expect(await pendingCount(context())).toBe(1);
    await logSession(
      { goal_id: goal.goal_id, start: new Date("2026-07-29T01:00:00.000Z"), end: new Date("2026-07-29T02:00:00.000Z") },
      context(),
    );
    expect(await pendingCount(context())).toBe(2);
  });
});
