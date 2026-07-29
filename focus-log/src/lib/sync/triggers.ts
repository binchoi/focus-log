/**
 * When to sync.
 *
 * Deliberately several overlapping triggers, because the cost of a redundant
 * sync is one batchGet while the cost of a missed one is stale data or a queue
 * that never drains. SyncEngine.sync() collapses concurrent calls into a single
 * in-flight run, so over-triggering is cheap.
 *
 * Background Sync (syncing while the app is closed) is deliberately not here —
 * it needs the JWT signing duplicated inside the service worker. Noted as
 * future work in EPCC_PLAN.md §2.4.
 */

export interface SyncTriggerOptions {
  /** Called when a sync should happen. Errors are the caller's problem. */
  onTrigger: (reason: string) => void;
  /** Coalescing window for mutation-driven triggers. */
  debounceMs?: number;
  /** Periodic sync while the page is visible. */
  pollMs?: number;
  /**
   * Fire once shortly after install. Scheduled on a timeout rather than called
   * inline so the caller's effect body performs no synchronous state update.
   */
  immediate?: boolean;
}

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_POLL_MS = 60_000;

/**
 * Wires up sync triggers and returns a teardown function.
 *
 * Every listener registered here is removed by the returned function. The old
 * code created a setInterval with no cleanup at all, leaking it for the lifetime
 * of the page (C5).
 */
export function installSyncTriggers(options: SyncTriggerOptions): () => void {
  if (typeof window === "undefined") return () => {};

  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let immediateTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const fire = (reason: string) => {
    if (!disposed) options.onTrigger(reason);
  };

  const onOnline = () => fire("online");
  const onVisibility = () => {
    if (document.visibilityState === "visible") fire("visible");
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);

  const startPolling = () => {
    pollTimer ??= setInterval(() => {
      // Don't poll a hidden tab: the timers are throttled anyway and it wastes
      // the user's Sheets quota.
      if (document.visibilityState === "visible" && navigator.onLine) fire("poll");
    }, pollMs);
  };
  startPolling();

  if (options.immediate !== false) {
    immediateTimer = setTimeout(() => fire("startup"), 0);
  }

  return () => {
    disposed = true;
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibility);
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    if (immediateTimer !== undefined) clearTimeout(immediateTimer);
  };
}

/** Debounces mutation-driven syncs so a burst of edits results in one push. */
export function createDebouncedTrigger(
  onTrigger: (reason: string) => void,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): { request: (reason: string) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    request(reason: string) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onTrigger(reason);
      }, debounceMs);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
