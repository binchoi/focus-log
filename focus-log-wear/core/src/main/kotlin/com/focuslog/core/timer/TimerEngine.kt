package com.focuslog.core.timer

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * Timer engine — a line-for-line port of the web app's `timer/engine.ts`.
 *
 * A session is a list of intervals and elapsed time is *always* derived from
 * wall-clock timestamps:
 *
 *     elapsed = Σ(closed segments) + (now − open segment start)
 *
 * Ticks only decide when to re-render; they never accumulate. This is the fix
 * for background throttling — and it matters more on Wear OS, where doze and app
 * standby are far more aggressive than a browser's. Even if the process is
 * killed mid-session, elapsed is recomputed correctly from the persisted open
 * segment on relaunch, so no focus time is lost.
 *
 * All times are epoch milliseconds (Long), matching `Date.now()` on the web.
 */
object TimerEngine {

    /** Prompt the user beyond this; probably a timer left running overnight. */
    const val LONG_SESSION_SECONDS: Long = 8L * 60 * 60

    /** Refuse to store beyond this. */
    const val MAX_SESSION_SECONDS: Long = 24L * 60 * 60

    /** Below this, warn that the session is trivially short before logging. */
    const val SHORT_SESSION_SECONDS: Long = 60

    fun phaseOf(state: TimerState?): TimerPhase {
        if (state == null || state.segments.isEmpty()) return TimerPhase.IDLE
        return if (state.segments.any { it.end == null }) TimerPhase.RUNNING else TimerPhase.PAUSED
    }

    /**
     * Elapsed seconds, derived from timestamps rather than counted.
     *
     * `now` is injected so this is exhaustively testable — including simulating a
     * throttled or suspended process, which is the bug this replaces.
     */
    fun elapsedSeconds(state: TimerState?, now: Long): Long {
        if (state == null) return 0
        var totalMs = 0L
        for (segment in state.segments) {
            val end = segment.end ?: now
            // Guard against a backwards system clock producing negative contributions.
            totalMs += max(0L, end - segment.start)
        }
        return Math.floorDiv(totalMs, 1000L)
    }

    fun start(goalId: String, now: Long, note: String = ""): TimerState =
        TimerState(goalId, listOf(Segment(now, null)), startedAt = now, note = note)

    /** Closes the open segment. No-op if already paused. */
    fun pause(state: TimerState, now: Long): TimerState {
        if (phaseOf(state) != TimerPhase.RUNNING) return state
        return state.copy(
            segments = state.segments.map { segment ->
                if (segment.end == null) segment.copy(end = max(segment.start, now)) else segment
            },
        )
    }

    /** Opens a new segment. No-op if already running. */
    fun resume(state: TimerState, now: Long): TimerState {
        if (phaseOf(state) == TimerPhase.RUNNING) return state
        return state.copy(segments = state.segments + Segment(now, null))
    }

    fun toggle(state: TimerState, now: Long): TimerState =
        if (phaseOf(state) == TimerPhase.RUNNING) pause(state, now) else resume(state, now)

    /** Closes the timer and returns the interval to log. */
    fun stop(state: TimerState, now: Long): StopResult {
        val closed = pause(state, now)
        val seconds = elapsedSeconds(closed, now)
        val startMs = closed.segments.firstOrNull()?.start ?: state.startedAt
        return StopResult(
            // Log the *focused* duration, not the wall-clock span, so pauses are excluded.
            startMillis = startMs,
            endMillis = startMs + seconds * 1000L,
            seconds = seconds,
            note = state.note,
        )
    }

    /**
     * Guardrails at stop time. The user is always told and always offered a
     * choice — the old code silently deleted sessions older than 24h.
     */
    fun warningFor(seconds: Long): SessionWarning? = when {
        seconds > MAX_SESSION_SECONDS -> SessionWarning(
            WarningKind.TOO_LONG,
            seconds,
            "This session is ${seconds / 3600} hours long, which is longer than a day. Trim it before logging.",
        )
        seconds >= LONG_SESSION_SECONDS -> SessionWarning(
            WarningKind.LONG,
            seconds,
            "That's ${seconds / 3600}h ${((seconds % 3600).toDouble() / 60).roundToLong()}m. Was the timer left running?",
        )
        seconds < SHORT_SESSION_SECONDS -> SessionWarning(
            WarningKind.SHORT,
            seconds,
            "Only ${seconds}s of focus. Log it anyway, or discard?",
        )
        else -> null
    }

    /**
     * Reconciles a timer restored from storage. We never discard it — we hand
     * back the state plus a warning if it now looks implausible.
     */
    fun restore(state: TimerState?, now: Long): RestoreResult {
        if (state == null || state.segments.isEmpty()) return RestoreResult(null, null)
        return RestoreResult(state, warningFor(elapsedSeconds(state, now)))
    }

    /**
     * Clamps an adjusted duration, allowing increases as well as decreases.
     * NaN means "no value entered" and becomes 0; infinities clamp to a bound.
     */
    fun clampAdjustment(seconds: Double): Long {
        if (seconds.isNaN()) return 0
        return min(MAX_SESSION_SECONDS, max(0L, Math.round(seconds)))
    }
}

/** A single focus interval. [end] is null while running. */
data class Segment(val start: Long, val end: Long?)

data class TimerState(
    val goalId: String,
    val segments: List<Segment>,
    val startedAt: Long,
    val note: String,
)

enum class TimerPhase { IDLE, RUNNING, PAUSED }

/** The interval to log when a timer is stopped. */
data class StopResult(
    val startMillis: Long,
    val endMillis: Long,
    val seconds: Long,
    val note: String,
)

enum class WarningKind { LONG, TOO_LONG, SHORT }

data class SessionWarning(val kind: WarningKind, val seconds: Long, val message: String)

data class RestoreResult(val state: TimerState?, val warning: SessionWarning?)
