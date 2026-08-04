import { beforeEach, describe, expect, it, vi } from "vitest";
import { FocusLogDb, setDbForTests } from "../store/db";
import { setTimerStoreForTests, TimerStore, timerStore } from "./store";
import { createActiveBridge } from "./activeBridge";
import { start } from "./engine";
import type { ActiveTimer } from "../sheets/schema";

const T0 = Date.parse("2026-07-29T10:00:00.000Z");
let dbCounter = 0;
let database: FocusLogDb;

beforeEach(async () => {
  dbCounter += 1;
  database = new FocusLogDb(`focus-log-bridge-${dbCounter}`);
  setDbForTests(database);
  await database.open();
  setTimerStoreForTests(new TimerStore(database));
  vi.stubGlobal("localStorage", { getItem: () => "dev-test", setItem: () => {} });
});

const remote = (logId: string, opts: Partial<ActiveTimer> = {}): ActiveTimer => ({
  log_id: logId,
  goal_id: "g1",
  segments: [{ start: T0, end: null }],
  note: "",
  updated_at: "2026-07-29T10:00:00.000Z",
  deleted: false,
  device_id: "dev-mac",
  ...opts,
});

describe("createActiveBridge", () => {
  it("readLocal reports the device's running timer, or undefined when idle", async () => {
    const bridge = createActiveBridge();
    expect(await bridge.readLocal()).toBeUndefined();

    await timerStore().write(start("g1", T0, "x", "L1"), T0);
    expect((await bridge.readLocal())?.log_id).toBe("L1");
  });

  it("apply adopts a reconciled remote timer", async () => {
    const bridge = createActiveBridge();
    await bridge.readLocal(); // idle
    await bridge.apply({ local: remote("R1"), changed: true });
    expect(timerStore().snapshot()?.logId).toBe("R1");
  });

  it("apply clears when reconciled to idle", async () => {
    await timerStore().write(start("g1", T0, "", "L1"), T0);
    const bridge = createActiveBridge();
    await bridge.readLocal();
    await bridge.apply({ local: undefined, changed: true });
    expect(timerStore().snapshot()).toBeUndefined();
  });

  it("skips the write (optimistic concurrency) when the local timer changed since read", async () => {
    await timerStore().write(start("g1", T0, "", "L1"), T0);
    const bridge = createActiveBridge();
    await bridge.readLocal(); // captures the T0 snapshot

    // A local action changes the timer between read and apply.
    await timerStore().write(start("g1", T0, "changed", "L1"), T0 + 5_000);

    await bridge.apply({ local: undefined, changed: true }); // would clear — must skip
    expect(timerStore().snapshot()?.logId).toBe("L1"); // untouched by the stale apply
  });

  it("enqueues a tombstone for an auto-closed losing concurrent start", async () => {
    await timerStore().write(start("g1", T0, "", "mine"), T0);
    await database.outbox.clear();
    const bridge = createActiveBridge();
    await bridge.readLocal();

    await bridge.apply({ local: remote("winner"), closeLogId: "mine", changed: true });

    const ops = await database.outbox.toArray();
    expect(
      ops.some(
        (o) =>
          o.entity === "active" &&
          o.entity_id === "mine" &&
          (o.payload as { deleted: boolean }).deleted,
      ),
    ).toBe(true);
    expect(timerStore().snapshot()?.logId).toBe("winner");
  });
});
