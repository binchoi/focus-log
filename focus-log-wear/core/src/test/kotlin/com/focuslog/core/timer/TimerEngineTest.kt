package com.focuslog.core.timer

import com.focuslog.core.timer.TimerEngine.LONG_SESSION_SECONDS
import com.focuslog.core.timer.TimerEngine.MAX_SESSION_SECONDS
import com.focuslog.core.timer.TimerEngine.clampAdjustment
import com.focuslog.core.timer.TimerEngine.elapsedSeconds
import com.focuslog.core.timer.TimerEngine.pause
import com.focuslog.core.timer.TimerEngine.phaseOf
import com.focuslog.core.timer.TimerEngine.restore
import com.focuslog.core.timer.TimerEngine.resume
import com.focuslog.core.timer.TimerEngine.start
import com.focuslog.core.timer.TimerEngine.stop
import com.focuslog.core.timer.TimerEngine.toggle
import com.focuslog.core.timer.TimerEngine.warningFor
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Port of `timer/engine.test.ts` — the executable spec for the timer. */
class TimerEngineTest {

    private val t0 = Instant.parse("2026-07-29T10:00:00.000Z").toEpochMilli()
    private fun minutes(n: Long) = n * 60_000L

    // --- C2 regression: elapsed is derived from the clock, never counted -----

    @Test
    fun `reports the full hour even if the tab only ticked twice`() {
        val state = start("goal-1", t0)
        assertEquals(1800, elapsedSeconds(state, t0 + minutes(30)))
        assertEquals(3600, elapsedSeconds(state, t0 + minutes(60)))
    }

    @Test
    fun `is identical whether the tab ticked 3600 times or once`() {
        val state = start("goal-1", t0)
        val oneTick = elapsedSeconds(state, t0 + minutes(60))
        var last = 0L
        for (second in 1..3600) last = elapsedSeconds(state, t0 + second * 1000L)
        assertEquals(oneTick, last)
        assertEquals(3600, last)
    }

    @Test
    fun `survives a device sleeping for hours mid-session`() {
        val state = start("goal-1", t0)
        assertEquals(185 * 60L, elapsedSeconds(state, t0 + minutes(185)))
    }

    @Test
    fun `does not go backwards if the system clock jumps back`() {
        val state = start("goal-1", t0)
        assertEquals(0, elapsedSeconds(state, t0 - minutes(10)))
    }

    @Test
    fun `is unaffected by a DST transition, because segments are absolute ms`() {
        val dstStart = Instant.parse("2026-03-08T09:30:00.000Z").toEpochMilli()
        val state = start("goal-1", dstStart)
        assertEquals(3600, elapsedSeconds(state, Instant.parse("2026-03-08T10:30:00.000Z").toEpochMilli()))
    }

    // --- phases --------------------------------------------------------------

    @Test
    fun `moves idle to running to paused to running`() {
        assertEquals(TimerPhase.IDLE, phaseOf(null))
        val running = start("goal-1", t0)
        assertEquals(TimerPhase.RUNNING, phaseOf(running))
        val paused = pause(running, t0 + minutes(10))
        assertEquals(TimerPhase.PAUSED, phaseOf(paused))
        val resumed = resume(paused, t0 + minutes(15))
        assertEquals(TimerPhase.RUNNING, phaseOf(resumed))
    }

    @Test
    fun `treats a state with no segments as idle`() {
        assertEquals(TimerPhase.IDLE, phaseOf(TimerState("g", emptyList(), t0, "")))
    }

    @Test
    fun `ignores a redundant pause or resume`() {
        val running = start("goal-1", t0)
        val paused = pause(running, t0 + minutes(5))
        assertSame(paused, pause(paused, t0 + minutes(6)))
        val resumed = resume(paused, t0 + minutes(7))
        assertSame(resumed, resume(resumed, t0 + minutes(8)))
    }

    @Test
    fun `toggles`() {
        val running = start("goal-1", t0)
        val paused = toggle(running, t0 + minutes(5))
        assertEquals(TimerPhase.PAUSED, phaseOf(paused))
        assertEquals(TimerPhase.RUNNING, phaseOf(toggle(paused, t0 + minutes(6))))
    }

    // --- pause and resume ----------------------------------------------------

    @Test
    fun `excludes paused time from the total`() {
        var state = start("goal-1", t0)
        state = pause(state, t0 + minutes(10))
        state = resume(state, t0 + minutes(30))
        assertEquals(minutes(15) / 1000, elapsedSeconds(state, t0 + minutes(35)))
    }

    @Test
    fun `freezes the total while paused, however long the pause lasts`() {
        var state = start("goal-1", t0)
        state = pause(state, t0 + minutes(10))
        assertEquals(600, elapsedSeconds(state, t0 + minutes(11)))
        assertEquals(600, elapsedSeconds(state, t0 + minutes(500)))
    }

    @Test
    fun `accumulates across many pause cycles`() {
        var state = start("goal-1", t0)
        var cursor = t0
        repeat(5) {
            cursor += minutes(6)
            state = pause(state, cursor)
            cursor += minutes(2)
            state = resume(state, cursor)
        }
        state = pause(state, cursor)
        assertEquals(minutes(30) / 1000, elapsedSeconds(state, cursor + minutes(100)))
    }

    // --- stop ----------------------------------------------------------------

    @Test
    fun `returns a start end pair spanning only focused time`() {
        var state = start("goal-1", t0)
        state = pause(state, t0 + minutes(10))
        state = resume(state, t0 + minutes(40))
        val result = stop(state, t0 + minutes(45))
        assertEquals(minutes(15) / 1000, result.seconds)
        assertEquals(minutes(15), result.endMillis - result.startMillis)
        assertEquals(t0, result.startMillis)
    }

    @Test
    fun `keeps seconds rather than truncating to minutes`() {
        val state = start("goal-1", t0)
        val result = stop(state, t0 + 1559 * 1000L)
        assertEquals(1559, result.seconds)
    }

    @Test
    fun `works on an already-paused timer`() {
        var state = start("goal-1", t0)
        state = pause(state, t0 + minutes(10))
        assertEquals(600, stop(state, t0 + minutes(90)).seconds)
    }

    @Test
    fun `carries the note through`() {
        val state = start("goal-1", t0, "chapter 3")
        assertEquals("chapter 3", stop(state, t0 + minutes(5)).note)
    }

    // --- guardrails ----------------------------------------------------------

    @Test
    fun `warns about a long session instead of silently deleting it`() {
        val warning = warningFor(LONG_SESSION_SECONDS + 60)
        assertEquals(WarningKind.LONG, warning?.kind)
        assertTrue(warning!!.message.contains("left running"))
    }

    @Test
    fun `refuses a session longer than a day, with an actionable message`() {
        val warning = warningFor(MAX_SESSION_SECONDS + 1)
        assertEquals(WarningKind.TOO_LONG, warning?.kind)
        assertTrue(warning!!.message.contains("Trim it"))
    }

    @Test
    fun `flags a sub-minute session but still offers to log it`() {
        val warning = warningFor(45)
        assertEquals(WarningKind.SHORT, warning?.kind)
        assertTrue(warning!!.message.contains("Log it anyway"))
    }

    @Test
    fun `says nothing about an ordinary session`() {
        assertNull(warningFor(1500))
        assertNull(warningFor(60))
        assertNull(warningFor(LONG_SESSION_SECONDS - 1))
    }

    // --- restore -------------------------------------------------------------

    @Test
    fun `recovers a running timer after a crash and reports the real elapsed time`() {
        val stored = start("goal-1", t0)
        val (state, warning) = restore(stored, t0 + minutes(45))
        assertSame(stored, state)
        assertNull(warning)
        assertEquals(minutes(45) / 1000, elapsedSeconds(state, t0 + minutes(45)))
    }

    @Test
    fun `keeps an overnight session and warns, rather than discarding it`() {
        val stored = start("goal-1", t0)
        val (state, warning) = restore(stored, t0 + minutes(60 * 10))
        assertNotNull(state)
        assertEquals(WarningKind.LONG, warning?.kind)
    }

    @Test
    fun `keeps a session older than the old 24h TTL`() {
        val stored = start("goal-1", t0)
        val (state, warning) = restore(stored, t0 + minutes(60 * 30))
        assertNotNull(state)
        assertEquals(WarningKind.TOO_LONG, warning?.kind)
    }

    @Test
    fun `returns idle for nothing stored`() {
        assertNull(restore(null, t0).state)
        assertNull(restore(TimerState("g", emptyList(), t0, ""), t0).state)
    }

    @Test
    fun `restores a paused timer without resuming it`() {
        var stored = start("goal-1", t0)
        stored = pause(stored, t0 + minutes(10))
        val (state, _) = restore(stored, t0 + minutes(200))
        assertEquals(TimerPhase.PAUSED, phaseOf(state))
        assertEquals(600, elapsedSeconds(state, t0 + minutes(200)))
    }

    // --- clampAdjustment -----------------------------------------------------

    @Test
    fun `permits increasing the duration`() {
        assertEquals(3600, clampAdjustment(3600.0))
        assertEquals(MAX_SESSION_SECONDS, clampAdjustment(MAX_SESSION_SECONDS.toDouble()))
    }

    @Test
    fun `clamps to the storable range instead of erroring on stray input`() {
        assertEquals(0, clampAdjustment(-500.0))
        assertEquals(MAX_SESSION_SECONDS, clampAdjustment(MAX_SESSION_SECONDS * 5.0))
        assertEquals(0, clampAdjustment(Double.NaN))
        assertEquals(MAX_SESSION_SECONDS, clampAdjustment(Double.POSITIVE_INFINITY))
        assertEquals(91, clampAdjustment(90.7))
    }
}
