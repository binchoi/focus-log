package com.focuslog.core.sheets

import com.focuslog.core.model.Goal
import com.focuslog.core.model.Session
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Covers the column layout, cell coercion, and row round-trip. */
class SheetsTest {

    // --- columns -------------------------------------------------------------

    @Test
    fun `column letters follow the spreadsheet sequence`() {
        assertEquals("A", columnLetter(0))
        assertEquals("Z", columnLetter(25))
        assertEquals("AA", columnLetter(26))
    }

    @Test
    fun `ranges span exactly the defined columns`() {
        assertEquals("goals!A:J", Ranges.goals) // 10 columns -> A..J
        assertEquals("sessions!A:L", Ranges.sessions) // 12 columns -> A..L
        assertEquals("meta!A:B", Ranges.meta)
    }

    @Test
    fun `header row is the column keys in order`() {
        assertEquals("goal_id", headerRow(GOAL_COLUMNS).first())
        assertEquals("device_id", headerRow(GOAL_COLUMNS).last())
        assertEquals(12, SESSION_COLUMNS.size)
    }

    // --- cells ---------------------------------------------------------------

    @Test
    fun `toNumber strips grouping separators so 1,234 does not collapse to 1`() {
        assertEquals(1234.0, toNumber("1,234"))
        assertEquals(1234.0, toNumber(1234))
    }

    @Test
    fun `toNumber refuses to guess on non-numeric input`() {
        assertNull(toNumber("health"))
        assertNull(toNumber(""))
        assertNull(toNumber(null))
    }

    @Test
    fun `toBoolean accepts every tombstone shape`() {
        assertTrue(toBoolean(true))
        assertTrue(toBoolean("TRUE"))
        assertTrue(toBoolean("true"))
        assertTrue(toBoolean(1))
        assertEquals(false, toBoolean("FALSE"))
        assertEquals(false, toBoolean(null))
    }

    @Test
    fun `cellAt treats a short row as blank rather than leaking null downstream`() {
        val row = listOf<Cell>("only-one")
        assertEquals("only-one", cellAt(row, 0))
        assertNull(cellAt(row, 5))
    }

    // --- row round-trip ------------------------------------------------------

    @Test
    fun `a goal survives serialise then parse`() {
        val goal = Goal(
            goalId = "goal-1",
            title = "Writing",
            color = "#ff7a18",
            weeklyTargetMinutes = 300,
            sortOrder = 1,
            status = "active",
            createdAt = "2026-07-29T10:00:00.000Z",
            updatedAt = "2026-07-29T10:00:00.000Z",
            deleted = false,
            deviceId = "wear-1",
        )
        val header = headerRow(GOAL_COLUMNS)
        val parsed = parseGoalRows(listOf(header, goalToRow(goal)))
        assertEquals(emptyList(), parsed.failures)
        assertEquals(goal, parsed.records.single())
    }

    @Test
    fun `a session survives serialise then parse`() {
        val session = Session(
            logId = "log-1",
            goalId = "goal-1",
            startUtc = "2026-07-29T10:00:00.000Z",
            endUtc = "2026-07-29T10:25:00.000Z",
            durationSeconds = 1500,
            localDate = "2026-07-29",
            tz = "Asia/Singapore",
            note = "chapter 3",
            source = "timer",
            updatedAt = "2026-07-29T10:25:00.000Z",
            deleted = false,
            deviceId = "wear-1",
        )
        val header = headerRow(SESSION_COLUMNS)
        val parsed = parseSessionRows(listOf(header, sessionToRow(session)))
        assertEquals(emptyList(), parsed.failures)
        assertEquals(session, parsed.records.single())
    }

    @Test
    fun `a malformed row is reported, not silently rendered as garbage`() {
        val header = headerRow(SESSION_COLUMNS)
        val bad = listOf<Cell>("log-2", "goal-1", "not-a-date", "also-bad", "health", "nope")
        val parsed = parseSessionRows(listOf(header, bad))
        assertTrue(parsed.records.isEmpty())
        assertEquals(1, parsed.failures.size)
        assertEquals(2, parsed.failures.first().sheetRow) // header + 1-based
    }

    @Test
    fun `wholly blank padding rows are skipped silently`() {
        val header = headerRow(GOAL_COLUMNS)
        val blank = listOf<Cell>("", "", "", null)
        val parsed = parseGoalRows(listOf(header, blank))
        assertTrue(parsed.records.isEmpty())
        assertTrue(parsed.failures.isEmpty())
    }
}
