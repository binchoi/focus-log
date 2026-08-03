package com.focuslog.core.time

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class TimeTest {

    @Test
    fun `toIsoUtc is always millisecond-precise UTC`() {
        assertEquals("1970-01-01T00:00:00.000Z", Time.toIsoUtc(0))
        assertEquals("2026-07-29T10:00:00.000Z", Time.toIsoUtc(Instant.parse("2026-07-29T10:00:00Z").toEpochMilli()))
    }

    @Test
    fun `durationSeconds keeps whole seconds and rounds, never floors to minutes`() {
        assertEquals(1559, Time.durationSeconds(0, 1_559_000))
        assertEquals(2, Time.durationSeconds(0, 1_500)) // 1.5s rounds to 2
        assertEquals(1500, Time.durationSeconds(0, 1_500_000))
    }

    @Test
    fun `localDateOf attributes the instant to the day in the given zone`() {
        val instant = Instant.parse("2026-07-29T16:00:00Z").toEpochMilli()
        assertEquals("2026-07-29", Time.localDateOf(instant, "UTC"))
        // +08:00 pushes 16:00Z to just past midnight the next day.
        assertEquals("2026-07-30", Time.localDateOf(instant, "Asia/Singapore"))
    }

    @Test
    fun `formatTotal reports sub-minute work honestly and rolls into hours`() {
        assertEquals("0m", Time.formatTotal(0))
        assertEquals("<1m", Time.formatTotal(30))
        assertEquals("2m", Time.formatTotal(90))
        assertEquals("1h", Time.formatTotal(3570)) // rounds 59.5m -> 60m -> 1h, not "1h 60m"
        assertEquals("1h 1m", Time.formatTotal(3660))
    }

    @Test
    fun `formatDuration rolls past an hour instead of showing 122 minutes`() {
        assertEquals("1:05", Time.formatDuration(65))
        assertEquals("25:59", Time.formatDuration(1559))
        assertEquals("2:02:05", Time.formatDuration(7325))
    }
}
