"use client";

/**
 * Sync status.
 *
 * States are deliberately distinct because "saved on this device" and "in the
 * spreadsheet" are different guarantees. The old app conflated them: a failed
 * write logged to the console and the user believed the session was saved (C1).
 */

import { AlertTriangle, Check, CloudOff, RefreshCw, UploadCloud } from "lucide-react";
import { cn } from "@/components/ui";
import { useApp } from "./providers";

/**
 * @param compact — icon-only square, for the phone top bar where there is no
 *   room for the status text. The text still ships as `sr-only` + `title`.
 */
export function SyncPill({ compact = false }: { compact?: boolean }) {
  const { status, syncNow } = useApp();

  const view = status.error
    ? { Icon: AlertTriangle, text: "Needs attention", tone: "text-danger border-danger/35" }
    : status.running
      ? { Icon: RefreshCw, text: "Syncing", tone: "text-ember-400 border-ember-500/30" }
      : status.offlineReason
        ? { Icon: CloudOff, text: "Offline", tone: "text-cream-400 border-ink-600" }
        : status.pending > 0
          ? {
              Icon: UploadCloud,
              text: `${status.pending} queued`,
              tone: "text-warn border-warn/30",
            }
          : { Icon: Check, text: "Synced", tone: "text-success border-success/25" };

  const detail =
    status.error ??
    status.offlineReason ??
    (status.pending > 0
      ? `${status.pending} change(s) saved here, waiting to upload`
      : status.lastSyncedAt
        ? `Last synced ${status.lastSyncedAt.toLocaleTimeString()}`
        : "Not synced yet");

  return (
    <button
      type="button"
      onClick={() => void syncNow()}
      disabled={status.running}
      title={detail}
      className={cn(
        "group flex items-center gap-2 rounded-lg border bg-ink-900/60 text-xs transition-colors duration-200",
        "hover:bg-ink-800 disabled:pointer-events-none",
        compact
          ? "h-9 w-9 justify-center"
          : "w-full justify-center px-2 py-2 md:justify-start md:px-2.5",
        view.tone,
      )}
    >
      <view.Icon size={14} className={cn("shrink-0", status.running && "animate-spin")} />
      <span className={cn("truncate", compact ? "sr-only" : "hidden md:block")}>{view.text}</span>
    </button>
  );
}

/** Wider variant for Settings, where there is room to explain. */
export function SyncDetail() {
  const { status, syncNow } = useApp();

  return (
    <div className="space-y-3">
      {status.error && (
        <div role="alert" className="rounded-lg border border-danger/35 bg-danger/8 px-3.5 py-2.5 text-sm text-danger">
          {status.error}
        </div>
      )}
      {status.offlineReason && !status.error && (
        <div role="status" className="rounded-lg border border-ink-600 bg-ink-850 px-3.5 py-2.5 text-sm text-cream-200">
          Offline. Your work is saved on this device and will upload by itself.
        </div>
      )}
      {status.malformedRows > 0 && (
        <div role="status" className="rounded-lg border border-warn/30 bg-warn/8 px-3.5 py-2.5 text-sm text-warn">
          {status.malformedRows} spreadsheet row(s) could not be read and were skipped.
        </div>
      )}
      <button
        type="button"
        onClick={() => void syncNow()}
        disabled={status.running}
        className="inline-flex h-10 items-center gap-2 rounded-lg border border-ink-600 bg-ink-800 px-4 text-sm text-cream-200 transition-colors hover:bg-ink-700 disabled:opacity-40"
      >
        <RefreshCw size={14} className={status.running ? "animate-spin" : undefined} />
        {status.running ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
