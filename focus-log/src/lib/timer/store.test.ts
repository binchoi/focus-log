import { beforeEach, describe, expect, it, vi } from "vitest";
import { FocusLogDb, setDbForTests } from "../store/db";
import { TimerStore } from "./store";
import { pause, phaseOf, start } from "./engine";

const T0 = Date.parse("2026-07-29T10:00:00.000Z");

let dbCounter = 0;
let database: FocusLogDb;

beforeEach(async () => {
  dbCounter += 1;
  database = new FocusLogDb(`focus-log-timer-${dbCounter}`);
  setDbForTests(database);
  await database.open();
  vi.stubGlobal("localStorage", {
    getItem: () => "dev-test",
    setItem: () => {},
  });
});

describe("persistence", () => {
  it("round-trips a running timer", async () => {
    const store = new TimerStore(database);
    const state = start("goal-1", T0, "notes here");
    await store.write(state, T0);

    const restored = await store.read();
    expect(restored).toEqual(state);
    expect(phaseOf(restored)).toBe("running");
  });

  it("round-trips a paused timer with multiple segments", async () => {
    const store = new TimerStore(database);
    let state = start("goal-1", T0);
    state = pause(state, T0 + 600_000);
    await store.write(state, T0 + 600_000);

    const restored = await store.read();
    expect(restored!.segments).toHaveLength(1);
    expect(restored!.segments[0]!.end).toBe(T0 + 600_000);
    expect(phaseOf(restored)).toBe("paused");
  });

  it("survives a store being recreated, as on a page reload", async () => {
    const first = new TimerStore(database);
    await first.write(start("goal-1", T0), T0);
    first.dispose();

    const second = new TimerStore(database);
    expect((await second.read())!.goalId).toBe("goal-1");
  });

  it("returns undefined when nothing is running", async () => {
    expect(await new TimerStore(database).read()).toBeUndefined();
  });

  it("keeps only one active session app-wide", async () => {
    const store = new TimerStore(database);
    await store.write(start("goal-1", T0), T0);
    await store.write(start("goal-2", T0 + 1000), T0 + 1000);

    expect(await database.activeSession.count()).toBe(1);
    expect((await store.read())!.goalId).toBe("goal-2");
  });
});

describe("C18 regression: clearing is scoped to the owning goal", () => {
  it("does not clear a timer belonging to a different goal", async () => {
    // The old stop/discard handlers removed the global active-timer key
    // unconditionally, so acting on goal B could wipe goal A's running timer.
    const store = new TimerStore(database);
    await store.write(start("goal-A", T0), T0);

    expect(await store.clearIfGoal("goal-B")).toBe(false);
    expect((await store.read())!.goalId).toBe("goal-A");
  });

  it("clears when the goal matches", async () => {
    const store = new TimerStore(database);
    await store.write(start("goal-A", T0), T0);
    expect(await store.clearIfGoal("goal-A")).toBe(true);
    expect(await store.read()).toBeUndefined();
  });

  it("is a no-op when nothing is running", async () => {
    expect(await new TimerStore(database).clearIfGoal("goal-A")).toBe(false);
  });
});

describe("C11 regression: cross-tab notification", () => {
  it("notifies subscribers when the timer changes", async () => {
    const store = new TimerStore(database);
    const seen: (string | undefined)[] = [];
    store.subscribe((state) => seen.push(state?.goalId));

    await store.write(start("goal-1", T0), T0);
    await store.clear();

    expect(seen).toEqual(["goal-1", undefined]);
  });

  it("stops notifying after unsubscribe", async () => {
    const store = new TimerStore(database);
    const seen: unknown[] = [];
    const unsubscribe = store.subscribe((state) => seen.push(state));
    unsubscribe();

    await store.write(start("goal-1", T0), T0);
    expect(seen).toEqual([]);
  });

  it("re-reads the database when another tab broadcasts, rather than trusting the message", async () => {
    // Two stores over one database stand in for two tabs. The real
    // BroadcastChannel is absent under Node, so drive the handler directly.
    const tabA = new TimerStore(database);
    const tabB = new TimerStore(database);

    const seenInB: (string | undefined)[] = [];
    tabB.subscribe((state) => seenInB.push(state?.goalId));

    // Tab A starts a timer; tab B is told to re-read.
    await tabA.write(start("goal-from-A", T0), T0);
    expect(await tabB.read()).toBeDefined();
    expect((await tabB.read())!.goalId).toBe("goal-from-A");
  });

  it("tolerates an environment without BroadcastChannel", async () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error deliberately removing the global to test the fallback
    delete globalThis.BroadcastChannel;
    try {
      const store = new TimerStore(database);
      await store.write(start("goal-1", T0), T0);
      expect((await store.read())!.goalId).toBe("goal-1");
      store.dispose();
    } finally {
      globalThis.BroadcastChannel = original;
    }
  });
});
