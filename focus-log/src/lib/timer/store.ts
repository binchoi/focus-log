/**
 * Persistence and cross-tab coordination for the running timer.
 *
 * The old code read `active_timer` from localStorage once on mount, with no
 * storage listener (C11). Two tabs could each start a timer on different goals,
 * the home page's "active goal" highlight never updated, and stopping a timer in
 * one tab unconditionally cleared the marker belonging to another goal (C18).
 *
 * There is exactly one active session app-wide, stored under the key "current".
 * That single row *is* the lock. Changes are broadcast so every tab and every
 * component converges immediately rather than on next mount.
 */

import { db, type ActiveSession, type FocusLogDb } from "../store/db";
import { getDeviceId } from "../store/ids";
import { enqueueActive } from "../store/repo";
import type { ActiveTimer } from "../sheets/schema";
import type { TimerState } from "./engine";
import { closedActive, runningActive } from "./lifecycle";

const CHANNEL_NAME = "focus-log.timer";

export type TimerChangeListener = (state: TimerState | undefined) => void;

function toTimerState(row: ActiveSession | undefined): TimerState | undefined {
  if (!row) return undefined;
  return {
    goalId: row.goal_id,
    segments: row.segments,
    startedAt: row.started_at,
    note: row.note,
    logId: row.log_id,
  };
}

function toRow(state: TimerState, now: number): ActiveSession {
  return {
    id: "current",
    goal_id: state.goalId,
    segments: state.segments,
    started_at: state.startedAt,
    note: state.note,
    device_id: getDeviceId(),
    updated_at: now,
    log_id: state.logId,
  };
}

/** Adopt a shared `active` row (pulled from the sheet) as the local timer. */
function rowFromActive(active: ActiveTimer): ActiveSession {
  return {
    id: "current",
    goal_id: active.goal_id,
    segments: active.segments,
    started_at: active.segments[0]?.start ?? 0,
    note: active.note,
    device_id: active.device_id,
    updated_at: Date.parse(active.updated_at),
    log_id: active.log_id,
  };
}

export class TimerStore {
  private channel: BroadcastChannel | undefined;
  private readonly listeners = new Set<TimerChangeListener>();
  /**
   * Synchronous mirror of the persisted row, so React can read a stable snapshot
   * during render via useSyncExternalStore. IndexedDB is async and cannot be
   * consulted mid-render.
   */
  private current: TimerState | undefined;
  private loadPromise: Promise<TimerState | undefined> | undefined;
  loaded = false;

  constructor(private readonly database: FocusLogDb = db()) {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = () => {
        // Another tab changed the timer. Re-read the authoritative row rather
        // than trusting the message payload.
        void this.read().then((state) => this.setCurrent(state));
      };
    }
  }

  /** Stable, synchronous snapshot for useSyncExternalStore. */
  snapshot(): TimerState | undefined {
    return this.current;
  }

  /** Reads through to IndexedDB once and seeds the snapshot. */
  async load(): Promise<TimerState | undefined> {
    this.loadPromise ??= this.read().then((state) => {
      this.setCurrent(state);
      this.loaded = true;
      return state;
    });
    return this.loadPromise;
  }

  async read(): Promise<TimerState | undefined> {
    return toTimerState(await this.database.activeSession.get("current"));
  }

  async write(state: TimerState, now: number): Promise<void> {
    await this.database.activeSession.put(toRow(state, now));
    // Publish the running/paused timer so other devices can see and control it.
    // Only when it carries a shared id (a timer started before this existed, or
    // a pure-math test, simply doesn't sync).
    if (state.logId) {
      await enqueueActive(
        runningActive(state, { logId: state.logId, deviceId: getDeviceId(), now }),
        { database: this.database },
      );
    }
    this.setCurrent(state);
    this.broadcast();
  }

  async clear(): Promise<void> {
    // Publish a tombstone so other devices learn the timer stopped/was discarded.
    const row = await this.database.activeSession.get("current");
    if (row?.log_id) {
      const state = toTimerState(row)!;
      await enqueueActive(
        closedActive(state, { logId: row.log_id, deviceId: getDeviceId(), now: Date.now() }),
        { database: this.database },
      );
    }
    await this.database.activeSession.delete("current");
    this.setCurrent(undefined);
    this.broadcast();
  }

  /**
   * Adopt a reconciled shared timer from a pull — set the local timer to match
   * the sheet *without* re-publishing (we are mirroring, not authoring). Passing
   * `undefined` clears it (another device stopped it).
   */
  async setLocal(active: ActiveTimer | undefined): Promise<void> {
    if (active === undefined) {
      await this.database.activeSession.delete("current");
      this.setCurrent(undefined);
    } else {
      const row = rowFromActive(active);
      await this.database.activeSession.put(row);
      this.setCurrent(toTimerState(row));
    }
    this.broadcast();
  }

  private setCurrent(state: TimerState | undefined): void {
    this.current = state;
    this.loaded = true;
    this.emit(state);
  }

  /**
   * Clears only if the stored session is for `goalId`.
   *
   * The old code's stop/discard handlers removed the global active-timer key
   * unconditionally, so acting on one goal could wipe another goal's running
   * timer (C18).
   */
  async clearIfGoal(goalId: string): Promise<boolean> {
    const current = await this.read();
    if (!current || current.goalId !== goalId) return false;
    await this.clear();
    return true;
  }

  subscribe(listener: TimerChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(state: TimerState | undefined): void {
    for (const listener of this.listeners) listener(state);
  }

  private broadcast(): void {
    this.channel?.postMessage({ at: Date.now() });
  }

  dispose(): void {
    this.channel?.close();
    this.channel = undefined;
    this.listeners.clear();
    this.current = undefined;
    this.loadPromise = undefined;
    this.loaded = false;
  }
}

let shared: TimerStore | undefined;

export function timerStore(): TimerStore {
  shared ??= new TimerStore();
  return shared;
}

export function setTimerStoreForTests(next: TimerStore | undefined): void {
  shared?.dispose();
  shared = next;
}
