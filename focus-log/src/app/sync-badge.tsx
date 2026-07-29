"use client";

/**
 * Sync status.
 *
 * Makes the queue visible. The old app gave no indication that anything had gone
 * wrong — a failed write logged to the console and the user believed the session
 * was saved (C1). Here "saved locally" and "uploaded" are distinct, honest states.
 */

import { useApp } from "./providers";

export function SyncBadge() {
  const { status, syncNow } = useApp();

  const label = status.running
    ? "Syncing…"
    : status.error
      ? "Sync problem"
      : status.pending > 0
        ? `${status.pending} to upload`
        : status.lastSyncedAt
          ? "Synced"
          : "Not synced yet";

  const tone = status.error
    ? "error"
    : status.offlineReason
      ? "offline"
      : status.pending > 0
        ? "pending"
        : "ok";

  return (
    <div className={`sync-badge sync-${tone}`}>
      <button
        type="button"
        onClick={() => void syncNow()}
        disabled={status.running}
        title={
          status.error ??
          status.offlineReason ??
          (status.lastSyncedAt ? `Last synced ${status.lastSyncedAt.toLocaleTimeString()}` : undefined)
        }
      >
        {label}
      </button>
      {status.offlineReason && (
        <span role="status" className="sync-note">
          Offline — saved on this device, will upload automatically.
        </span>
      )}
      {status.error && (
        <span role="alert" className="sync-note">
          {status.error}
        </span>
      )}
    </div>
  );
}
