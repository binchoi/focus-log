package com.focuslog.core.timer

import com.focuslog.core.model.ActiveTimer
import com.focuslog.core.model.Session
import com.focuslog.core.sync.compareVersions
import com.focuslog.core.time.Time

/**
 * Active-timer lifecycle — the pure bridge between a running [TimerState] and the
 * two things the shared sheet holds: the `active` row (so another device can see
 * and control the timer) and, at stop, the finalized [Session] row. A port of the
 * web core's `timer/lifecycle.ts`.
 *
 * The session's `logId` is minted once at start and threaded through here to
 * finalise, so two devices ending the same timer append rows with the same id
 * that the last-write-wins reducer collapses — no double-count, no server. Pure
 * and injected, and pinned to the web core by /conformance/active-mapping.json.
 */

data class ActiveContext(
    /** The session id, minted at start and reused at finalise. */
    val logId: String,
    val deviceId: String,
    /** Epoch ms; the LWW clock stamped on the produced row. */
    val now: Long,
)

/** Publish the current running/paused timer as its shared `active` row. */
fun runningActive(state: TimerState, ctx: ActiveContext): ActiveTimer = ActiveTimer(
    logId = ctx.logId,
    goalId = state.goalId,
    segments = state.segments,
    note = state.note,
    updatedAt = Time.toIsoUtc(ctx.now),
    deleted = false,
    deviceId = ctx.deviceId,
)

/** The tombstone that ends the shared timer — written on stop or discard. */
fun closedActive(state: TimerState, ctx: ActiveContext): ActiveTimer =
    runningActive(state, ctx).copy(deleted = true)

/**
 * Reconstruct a [TimerState] from a pulled `active` row, so another device can
 * display and control a timer it did not start. Elapsed is always re-derived from
 * `segments`, never stored.
 */
fun timerFromActive(active: ActiveTimer): TimerState = TimerState(
    goalId = active.goalId,
    segments = active.segments,
    startedAt = active.segments.firstOrNull()?.start ?: 0L,
    note = active.note,
)

/**
 * The finalized [Session] for a stopping timer, under the reserved `logId`.
 * Focused duration only (pauses excluded), attributed to the local day it
 * started — identical semantics to `Repo.logSession`, but pure.
 */
fun finalizedSession(state: TimerState, ctx: ActiveContext, tz: String): Session {
    val r = TimerEngine.stop(state, ctx.now)
    return Session(
        logId = ctx.logId,
        goalId = state.goalId,
        startUtc = Time.toIsoUtc(r.startMillis),
        endUtc = Time.toIsoUtc(r.endMillis),
        durationSeconds = r.seconds.toInt(),
        localDate = Time.localDateOf(r.startMillis, tz),
        tz = tz,
        note = r.note.trim(),
        source = "timer",
        updatedAt = Time.toIsoUtc(ctx.now),
        deleted = false,
        deviceId = ctx.deviceId,
    )
}

// ---------------------------------------------------------------------------
// Reconcile (what a device's local timer should become after a pull)
// ---------------------------------------------------------------------------

/**
 * The result of reconciling this device's local timer with the sheet's `active`
 * rows — a port of the web core's `reconcileActive`.
 */
data class Reconciliation(
    /** What this device's local timer should become — null means idle/clear. */
    val local: ActiveTimer?,
    /**
     * A `logId` this device should tombstone: it authored a concurrently-started
     * timer that lost the earliest-start race, so it is auto-closed (no session is
     * logged — a spurious double-start is discarded, not counted).
     */
    val closeLogId: String? = null,
    /** True when [local] differs from the input and must be persisted + broadcast. */
    val changed: Boolean,
)

private fun startedAtOf(active: ActiveTimer): Long = active.segments.firstOrNull()?.start ?: 0L

/**
 * The single shared timer, if any: the earliest-started live (non-tombstoned)
 * record, ties broken by `logId`. Deterministic so every device agrees.
 */
private fun earliestLive(candidates: List<ActiveTimer>): ActiveTimer? {
    var winner: ActiveTimer? = null
    for (c in candidates) {
        if (c.deleted) continue
        val w = winner
        if (w == null ||
            startedAtOf(c) < startedAtOf(w) ||
            (startedAtOf(c) == startedAtOf(w) && c.logId < w.logId)
        ) {
            winner = c
        }
    }
    return winner
}

/**
 * Reconcile this device's local running timer with the `active` rows pulled from
 * the sheet. Pure and deterministic, so two devices converge on the same shared
 * timer without a server. Never logs a session — finishing is always an explicit
 * user action (see [finalizedSession]); this only mirrors *liveness*.
 *
 * Rules, in order:
 *  1. If the sheet has tombstoned *my* timer (same `logId`, `deleted`), it was
 *     stopped or discarded on another device -> go idle.
 *  2. Otherwise adopt any newer remote version of my own timer (LWW).
 *  3. The shared timer is the earliest-started live record among {remote + mine}:
 *     idle here -> adopt it; it's mine -> keep it; a different earlier timer ->
 *     adopt it and auto-close mine.
 *
 * [remote] is the reduced-by-`logId` latest of each active row (tombstones
 * included), i.e. the output of the same LWW reducer used for goals/sessions.
 */
fun reconcileActive(local: ActiveTimer?, remote: List<ActiveTimer>): Reconciliation {
    val input = local
    var current = local

    if (current != null) {
        val mine = remote.firstOrNull { it.logId == current!!.logId }
        // (1) my timer was ended elsewhere.
        if (mine?.deleted == true) return Reconciliation(local = null, changed = input != null)
        // (2) adopt a newer remote version of my own timer.
        if (mine != null && compareVersions(mine, current!!) > 0) current = mine
    }

    val candidates = if (current != null) remote + current!! else remote
    val winner = earliestLive(candidates)
        ?: return Reconciliation(local = null, changed = input != null)

    // Was idle: adopt the shared timer.
    if (current == null) return Reconciliation(local = winner, changed = true)

    // I hold the shared timer: keep it (possibly the newer version adopted in (2)).
    if (winner.logId == current!!.logId) {
        return Reconciliation(local = current, changed = input != current)
    }

    // A different, earlier timer wins: adopt it and auto-close my losing start.
    return Reconciliation(local = winner, closeLogId = current!!.logId, changed = true)
}
