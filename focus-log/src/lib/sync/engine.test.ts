import { beforeEach, describe, expect, it, vi } from "vitest";
import { FocusLogDb, setDbForTests } from "../store/db";
import {
  createGoal,
  deleteSession,
  listSessions,
  logSession,
  pendingCount,
  updateSession,
} from "../store/repo";
import { SheetsClient, SheetsError } from "../sheets/client";
import { RANGES } from "../sheets/columns";
import { headerRow, GOAL_COLUMNS, SESSION_COLUMNS } from "../sheets/columns";
import { parseSessionRows, sessionToRow, type Session } from "../sheets/schema";
import { SyncEngine, isSchemaCompatible } from "./engine";
import { reduceLatest } from "./merge";

let dbCounter = 0;
let database: FocusLogDb;

const context = () => ({
  database,
  now: () => new Date(clock),
  deviceId: () => "dev-test",
  timeZone: () => "Asia/Singapore",
});

let clock = Date.parse("2026-07-29T10:00:00.000Z");
const tick = (ms: number) => (clock += ms);

/**
 * A fake spreadsheet that behaves like the real one: appends accumulate,
 * nothing is updated in place, and reads return the whole log.
 */
class FakeSheet {
  goals: unknown[][] = [headerRow(GOAL_COLUMNS)];
  sessions: unknown[][] = [headerRow(SESSION_COLUMNS)];
  meta: unknown[][] = [
    ["key", "value"],
    ["schema_version", "1"],
  ];
  offline = false;
  appendCalls = 0;
  /** Simulates "the append succeeded but the response never arrived". */
  swallowNextResponse = false;

  client(maxAttempts = 2): SheetsClient {
    const sheet = this;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (sheet.offline) throw new TypeError("Failed to fetch");

      if (url.pathname.endsWith(":batchGet")) {
        const ranges = url.searchParams.getAll("ranges");
        return new Response(
          JSON.stringify({
            valueRanges: ranges.map((range) => ({
              values:
                range === RANGES.goals
                  ? sheet.goals
                  : range === RANGES.sessions
                    ? sheet.sessions
                    : sheet.meta,
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.pathname.endsWith(":append")) {
        sheet.appendCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          range: string;
          values: unknown[][];
        };
        const target = body.range === RANGES.goals ? sheet.goals : sheet.sessions;
        target.push(...body.values);
        if (sheet.swallowNextResponse) {
          sheet.swallowNextResponse = false;
          // Row is durably written, but the client sees a network failure.
          throw new TypeError("Failed to fetch");
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    return new SheetsClient({
      spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
      tokens: { getAccessToken: async () => "token" },
      fetchImpl,
      retry: { maxAttempts, sleep: async () => {}, jitter: () => 0 },
    });
  }

  sessionRecords(): Session[] {
    return parseSessionRows(this.sessions as never).records;
  }
}

beforeEach(async () => {
  dbCounter += 1;
  database = new FocusLogDb(`focus-log-test-${dbCounter}`);
  setDbForTests(database);
  await database.open();
  clock = Date.parse("2026-07-29T10:00:00.000Z");
});

describe("C1 regression: a session survives a failed write", () => {
  it("commits locally and queues when offline, then syncs when back online", async () => {
    const sheet = new FakeSheet();
    const engine = new SyncEngine(sheet.client(), { database, now: () => new Date(clock) });

    const goal = await createGoal({ title: "Deep work" }, context());

    // Go offline and log a 25m59s session.
    sheet.offline = true;
    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:25:59.000Z"),
      },
      context(),
    );

    // The old code deleted its local state before the network call, so this
    // session would simply be gone. Here it is committed locally and queued.
    expect(await listSessions({}, context())).toHaveLength(1);
    expect(session.duration_seconds).toBe(1559);
    expect(await pendingCount(context())).toBe(2); // goal + session

    // Syncing while offline defers rather than throwing — being offline is an
    // ordinary state for this app, not an error.
    const offlineResult = await engine.sync();
    expect(offlineResult.pushed).toBe(0);
    expect(offlineResult.deferred).toBe(true);
    expect(offlineResult.deferredReason).toMatch(/Failed to fetch/);
    expect(offlineResult.stillPending).toBe(2);
    expect(await listSessions({}, context())).toHaveLength(1);

    // Back online.
    sheet.offline = false;
    const result = await engine.sync();
    expect(result.pushed).toBe(2);
    expect(result.stillPending).toBe(0);

    const inSheet = sheet.sessionRecords();
    expect(inSheet).toHaveLength(1);
    expect(inSheet[0]!.log_id).toBe(session.log_id);
    expect(inSheet[0]!.duration_seconds).toBe(1559);
  });

  it("survives the browser dying between commit and push", async () => {
    const sheet = new FakeSheet();
    const goal = await createGoal({ title: "Reading" }, context());
    await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:30:00.000Z"),
      },
      context(),
    );

    // Simulate a fresh page load: brand-new engine, same IndexedDB.
    const revived = new SyncEngine(sheet.client(), { database, now: () => new Date(clock) });
    const result = await revived.sync();

    expect(result.pushed).toBe(2);
    expect(sheet.sessionRecords()).toHaveLength(1);
  });

  it("keeps a queued op when the append fails non-retryably, rather than dropping it", async () => {
    const failing = new SheetsClient({
      spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
      tokens: { getAccessToken: async () => "token" },
      fetchImpl: async () => new Response("forbidden", { status: 403 }),
      retry: { maxAttempts: 1, sleep: async () => {}, jitter: () => 0 },
    });
    const engine = new SyncEngine(failing, { database, now: () => new Date(clock) });

    await createGoal({ title: "Blocked" }, context());
    await expect(engine.sync()).rejects.toBeInstanceOf(SheetsError);

    // Still queued, with the failure recorded for the UI to show.
    expect(await pendingCount(context())).toBe(1);
    const [op] = await database.outbox.toArray();
    expect(op!.attempts).toBe(1);
    expect(op!.last_error).toMatch(/shared with the service account/);
    expect(op!.leased_until).toBeUndefined();
  });
});

describe("idempotency", () => {
  it("a lost response does not create a duplicate session (engine-level retry)", async () => {
    const sheet = new FakeSheet();
    // maxAttempts 1 so the lost response surfaces to the engine rather than
    // being absorbed by the client's own retry.
    const engine = new SyncEngine(sheet.client(1), { database, now: () => new Date(clock) });

    const goal = await createGoal({ title: "Writing" }, context());
    await engine.sync();

    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:30:00.000Z"),
      },
      context(),
    );

    // The row lands in the sheet but the client never learns that.
    sheet.swallowNextResponse = true;
    const deferred = await engine.sync();
    expect(deferred.pushed).toBe(0);
    expect(deferred.deferred).toBe(true);
    expect(await pendingCount(context())).toBe(1); // still queued, correctly

    // The next run retries and appends the identical row a second time.
    await engine.sync();
    expect(sheet.sessions.length).toBe(3); // header + two identical rows
    expect(await pendingCount(context())).toBe(0);

    // Both rows carry the same log_id and updated_at, so the reducer collapses
    // them: the user sees one session, not two.
    const collapsed = reduceLatest(sheet.sessionRecords(), (s) => s.log_id);
    expect(collapsed.size).toBe(1);
    expect(collapsed.get(session.log_id)!.duration_seconds).toBe(1800);
    expect(await listSessions({}, context())).toHaveLength(1);
  });

  it("a lost response absorbed by the client's own retry also yields one session", async () => {
    // Same hazard, one layer lower: the client retries internally, so the row
    // is appended twice inside a single sync and the op is cleared normally.
    const sheet = new FakeSheet();
    const engine = new SyncEngine(sheet.client(2), { database, now: () => new Date(clock) });
    const goal = await createGoal({ title: "Writing" }, context());
    await engine.sync();

    await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:30:00.000Z"),
      },
      context(),
    );

    sheet.swallowNextResponse = true;
    expect((await engine.sync()).pushed).toBe(1);
    expect(sheet.sessions.length).toBe(3); // header + two identical rows
    expect(reduceLatest(sheet.sessionRecords(), (s) => s.log_id).size).toBe(1);
    expect(await listSessions({}, context())).toHaveLength(1);
  });

  it("collapses repeated local edits into a single queued op", async () => {
    const goal = await createGoal({ title: "Iterating" }, context());
    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:30:00.000Z"),
      },
      context(),
    );

    tick(1000);
    await updateSession(session.log_id, { note: "first" }, context());
    tick(1000);
    await updateSession(session.log_id, { note: "second" }, context());
    tick(1000);
    await updateSession(session.log_id, { note: "third" }, context());

    // One op per record, holding the newest version — not four appends.
    const ops = await database.outbox.where("entity_id").equals(session.log_id).toArray();
    expect(ops).toHaveLength(1);
    expect((ops[0]!.payload as Session).note).toBe("third");
  });
});

describe("pull and merge", () => {
  it("adopts a session created on another device", async () => {
    const sheet = new FakeSheet();
    const engine = new SyncEngine(sheet.client(), { database, now: () => new Date(clock) });

    const remote: Session = {
      log_id: "remote-session-1",
      goal_id: "remote-goal-1",
      start_utc: "2026-07-28T09:00:00.000Z",
      end_utc: "2026-07-28T10:00:00.000Z",
      duration_seconds: 3600,
      local_date: "2026-07-28",
      tz: "Asia/Singapore",
      note: "from phone",
      source: "timer",
      updated_at: "2026-07-28T10:00:01.000Z",
      deleted: false,
      device_id: "dev-phone",
    };
    sheet.sessions.push(sessionToRow(remote));

    const result = await engine.sync();
    expect(result.pulled.sessions).toBe(1);
    const local = await listSessions({}, context());
    expect(local[0]!.note).toBe("from phone");
  });

  it("propagates a remote tombstone so a delete on another device sticks", async () => {
    const sheet = new FakeSheet();
    const engine = new SyncEngine(sheet.client(), { database, now: () => new Date(clock) });
    const goal = await createGoal({ title: "Temp" }, context());
    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:30:00.000Z"),
      },
      context(),
    );
    await engine.sync();
    expect(await listSessions({}, context())).toHaveLength(1);

    // Another device deletes it: a tombstone row appears in the sheet.
    const [existing] = sheet.sessionRecords().filter((s) => s.log_id === session.log_id);
    sheet.sessions.push(
      sessionToRow({
        ...existing!,
        deleted: true,
        updated_at: "2026-07-29T12:00:00.000Z",
        device_id: "dev-phone",
      }),
    );

    await engine.sync();
    expect(await listSessions({}, context())).toHaveLength(0);
  });

  it("pushes a local delete as a tombstone", async () => {
    const sheet = new FakeSheet();
    const engine = new SyncEngine(sheet.client(), { database, now: () => new Date(clock) });
    const goal = await createGoal({ title: "Temp" }, context());
    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:30:00.000Z"),
      },
      context(),
    );
    await engine.sync();

    tick(5000);
    await deleteSession(session.log_id, context());
    await engine.sync();

    const collapsed = reduceLatest(sheet.sessionRecords(), (s) => s.log_id);
    expect(collapsed.get(session.log_id)!.deleted).toBe(true);
  });

  it("reports malformed remote rows instead of swallowing them", async () => {
    const sheet = new FakeSheet();
    const engine = new SyncEngine(sheet.client(), { database, now: () => new Date(clock) });

    // A row using the old ambiguous datetime format.
    sheet.sessions.push([
      "legacy-1",
      "goal-1",
      "01/15/2025 14:30:00",
      "01/15/2025 15:00:00",
      30,
      "2025-01-15",
      "UTC",
      "",
      "timer",
      "2025-01-15T15:00:00.000Z",
      false,
      "old",
    ]);

    const result = await engine.sync();
    expect(result.malformed.sessions).toHaveLength(1);
    expect(result.malformed.sessions[0]!.problems.join(" ")).toContain("start_utc");
    // And it did not become a record with a garbage date.
    expect(await listSessions({}, context())).toHaveLength(0);
  });

  it("reads the schema version and flags an incompatible sheet", async () => {
    const sheet = new FakeSheet();
    const engine = new SyncEngine(sheet.client(), { database, now: () => new Date(clock) });
    expect((await engine.sync()).schemaVersion).toBe(1);
    // Older and current sheets are both compatible (older just leaves newer
    // features off); only a *newer* sheet is refused.
    expect(isSchemaCompatible(1)).toBe(true);
    expect(isSchemaCompatible(2)).toBe(true);
    expect(isSchemaCompatible(3)).toBe(false);
    expect(isSchemaCompatible(undefined)).toBe(true);
  });
});

describe("concurrency", () => {
  it("shares one in-flight run between simultaneous triggers", async () => {
    const sheet = new FakeSheet();
    const engine = new SyncEngine(sheet.client(), { database, now: () => new Date(clock) });
    await createGoal({ title: "Concurrent" }, context());

    // online + visibilitychange + poll all firing at once.
    const [a, b, c] = await Promise.all([engine.sync(), engine.sync(), engine.sync()]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(sheet.appendCalls).toBe(1); // not three
  });

  it("reclaims an expired lease so work abandoned mid-push is retried", async () => {
    const sheet = new FakeSheet();
    await createGoal({ title: "Abandoned" }, context());

    // Pretend a previous run leased the op and then died.
    const [op] = await database.outbox.toArray();
    await database.outbox.put({ ...op!, leased_until: clock - 1 });

    const engine = new SyncEngine(sheet.client(), { database, now: () => new Date(clock) });
    expect((await engine.sync()).pushed).toBe(1);
  });

  it("does not retry an op that exhausted its attempts, but keeps it for the user", async () => {
    const sheet = new FakeSheet();
    await createGoal({ title: "Stuck" }, context());
    const [op] = await database.outbox.toArray();
    await database.outbox.put({ ...op!, attempts: 99 });

    const engine = new SyncEngine(sheet.client(), {
      database,
      now: () => new Date(clock),
      maxAttempts: 10,
    });

    expect((await engine.sync()).pushed).toBe(0);
    expect(await pendingCount(context())).toBe(1);
    expect(await engine.stuckOps()).toHaveLength(1);
  });
});

describe("repo guardrails", () => {
  it("C3 regression: allows adjusting a duration upward", async () => {
    const goal = await createGoal({ title: "Adjustable" }, context());
    // Background throttling under-counted a 60m session as 20m; the user must
    // be able to correct it upward. The old UI blocked any value above the
    // recorded time.
    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T09:00:00.000Z"),
        end: new Date("2026-07-29T09:20:00.000Z"),
        durationSecondsOverride: 3600,
      },
      context(),
    );
    expect(session.duration_seconds).toBe(3600);
    // end_utc is moved so start/end/duration stay consistent.
    expect(session.end_utc).toBe("2026-07-29T10:00:00.000Z");
  });

  it("C12 regression: refuses an absurd duration instead of silently discarding it", async () => {
    const goal = await createGoal({ title: "Runaway" }, context());
    await expect(
      logSession(
        {
          goal_id: goal.goal_id,
          start: new Date("2026-07-29T09:00:00.000Z"),
          end: new Date("2026-07-29T09:30:00.000Z"),
          durationSecondsOverride: 48 * 3600,
        },
        context(),
      ),
    ).rejects.toThrow(/cannot exceed 24 hours/);
  });

  it("rejects a negative adjustment", async () => {
    const goal = await createGoal({ title: "Negative" }, context());
    await expect(
      logSession(
        {
          goal_id: goal.goal_id,
          start: new Date("2026-07-29T09:00:00.000Z"),
          end: new Date("2026-07-29T09:30:00.000Z"),
          durationSecondsOverride: -60,
        },
        context(),
      ),
    ).rejects.toThrow(/negative/);
  });

  it("attributes a session to the local day it started, in the user's zone", async () => {
    const goal = await createGoal({ title: "Late night" }, context());
    // 23:30 Singapore on the 29th == 15:30Z on the 29th.
    const session = await logSession(
      {
        goal_id: goal.goal_id,
        start: new Date("2026-07-29T15:30:00.000Z"),
        end: new Date("2026-07-29T16:30:00.000Z"),
      },
      context(),
    );
    expect(session.local_date).toBe("2026-07-29");
    expect(session.tz).toBe("Asia/Singapore");
  });
});
