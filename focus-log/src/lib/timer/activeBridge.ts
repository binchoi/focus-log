/**
 * Bridges the {@link import("../sync/engine").SyncEngine} to this device's
 * running timer, so pull can reconcile the shared `active` tab into the local
 * timer without the engine ever touching the timer store directly.
 *
 * `apply` writes under **optimistic concurrency**: if the local timer changed
 * between being read and the result being applied (the user paused or stopped
 * mid-pull), the write is skipped. That is safe because reconcile is idempotent —
 * the next pull recomputes from the sheet and applies the fresh result.
 */

import { db, type ActiveSession } from "../store/db";
import { enqueueActive } from "../store/repo";
import { timerStore } from "./store";
import { toIsoUtc } from "../time";
import type { ActiveTimer } from "../sheets/schema";
import type { ActiveBridge } from "../sync/engine";

function activeFromRow(row: ActiveSession | undefined): ActiveTimer | undefined {
  if (!row || !row.log_id) return undefined;
  return {
    log_id: row.log_id,
    goal_id: row.goal_id,
    segments: row.segments,
    note: row.note,
    // Preserve the stored instant — reconcile is last-write-wins, so stamping
    // "now" here would make the local timer always look newest and never adopt a
    // pause made on another device.
    updated_at: toIsoUtc(new Date(row.updated_at)),
    deleted: false,
    device_id: row.device_id,
  };
}

export function createActiveBridge(): ActiveBridge {
  let seenUpdatedAt: number | undefined;
  let seenLocal: ActiveTimer | undefined;

  return {
    readLocal: async () => {
      const row = await db().activeSession.get("current");
      seenUpdatedAt = row?.updated_at;
      seenLocal = activeFromRow(row);
      return seenLocal;
    },

    apply: async (result) => {
      const row = await db().activeSession.get("current");
      if (row?.updated_at !== seenUpdatedAt) return; // a local action won; skip.

      if (result.closeLogId && seenLocal && seenLocal.log_id === result.closeLogId) {
        // Auto-close our losing concurrent start: a tombstone, no session logged.
        await enqueueActive({ ...seenLocal, deleted: true, updated_at: toIsoUtc(new Date()) });
      }
      await timerStore().setLocal(result.local);
    },
  };
}
