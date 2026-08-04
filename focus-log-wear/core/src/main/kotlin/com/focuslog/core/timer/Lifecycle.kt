package com.focuslog.core.timer

import com.focuslog.core.model.ActiveTimer
import com.focuslog.core.model.Session
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
