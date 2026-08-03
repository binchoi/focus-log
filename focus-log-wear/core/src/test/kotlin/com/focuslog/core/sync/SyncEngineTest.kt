package com.focuslog.core.sync

import com.focuslog.core.model.Goal
import com.focuslog.core.sheets.GOAL_COLUMNS
import com.focuslog.core.sheets.Ranges
import com.focuslog.core.sheets.SheetRead
import com.focuslog.core.sheets.SheetsError
import com.focuslog.core.sheets.SheetsErrorKind
import com.focuslog.core.sheets.goalToRow
import com.focuslog.core.sheets.headerRow
import com.focuslog.core.store.Repo
import com.focuslog.core.testfixtures.FakeSheetsClient
import com.focuslog.core.testfixtures.FakeStore
import com.focuslog.core.testfixtures.sheetValues
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class SyncEngineTest {

    private val clock = 1_700_000_000_000L

    private fun repo(store: FakeStore): Repo {
        var counter = 0
        return Repo(store, now = { clock }, ids = { "id-${++counter}" }, deviceId = { "wear-test" }, timeZone = { "UTC" })
    }

    private fun remoteGoal() = Goal(
        goalId = "goal-remote",
        title = "From another device",
        color = "#4caf50",
        weeklyTargetMinutes = 120,
        sortOrder = 0,
        status = "active",
        createdAt = "2026-07-29T09:00:00.000Z",
        updatedAt = "2026-07-29T09:00:00.000Z",
        deleted = false,
        deviceId = "desktop-1",
    )

    @Test
    fun `push drains the outbox, goals before sessions`() = runTest {
        val store = FakeStore()
        val r = repo(store)
        r.createGoal(title = "Writing")
        r.logSession("goal-1", 0, 60_000)

        val client = FakeSheetsClient()
        val outcome = SyncEngine(client, store, now = { clock }).push()

        assertEquals(2, outcome.pushed)
        assertEquals(0, store.outboxCount())
        assertEquals(listOf(Ranges.goals, Ranges.sessions), client.appendOrder)
    }

    @Test
    fun `a retryable push failure defers and keeps the ops queued`() = runTest {
        val store = FakeStore()
        val r = repo(store)
        r.createGoal(title = "Writing")
        r.logSession("goal-1", 0, 60_000)

        val client = FakeSheetsClient(appendError = SheetsError("offline", 0, SheetsErrorKind.NETWORK, true))
        val outcome = SyncEngine(client, store, now = { clock }).push()

        assertEquals(0, outcome.pushed)
        assertNotNull(outcome.deferredReason)
        assertEquals(2, store.outboxCount())
        // Attempts incremented, lease cleared so the next trigger retries them.
        assertTrue(store.outboxAll().all { it.attempts == 1 && it.leasedUntil == null })
    }

    @Test
    fun `a terminal push failure propagates so the user can fix it`() = runTest {
        val store = FakeStore()
        repo(store).createGoal(title = "Writing")

        val client = FakeSheetsClient(
            appendError = SheetsError("not shared", 403, SheetsErrorKind.PERMISSION, false),
        )
        assertFailsWith<SheetsError> { SyncEngine(client, store, now = { clock }).sync() }
    }

    @Test
    fun `pull adopts a record only the sheet has`() = runTest {
        val store = FakeStore()
        val goal = remoteGoal()
        val client = FakeSheetsClient(
            readResult = SheetRead(
                goals = sheetValues(headerRow(GOAL_COLUMNS), listOf(goalToRow(goal))),
                sessions = emptyList(),
                meta = emptyList(),
            ),
        )
        val result = SyncEngine(client, store, now = { clock }).pull()

        assertEquals(1, result.pulled.goals)
        assertEquals(goal, store.getGoal(goal.goalId))
    }

    @Test
    fun `sync both pushes local work and pulls remote work in one run`() = runTest {
        val store = FakeStore()
        val r = repo(store)
        r.logSession("goal-1", 0, 60_000) // queued locally

        val goal = remoteGoal()
        val client = FakeSheetsClient(
            readResult = SheetRead(
                goals = sheetValues(headerRow(GOAL_COLUMNS), listOf(goalToRow(goal))),
                sessions = emptyList(),
                meta = emptyList(),
            ),
        )
        val result = SyncEngine(client, store, now = { clock }).sync()

        assertEquals(1, result.pushed)
        assertTrue(client.appended[Ranges.sessions]!!.isNotEmpty())
        assertEquals(goal, store.getGoal(goal.goalId))
        assertEquals(0, store.outboxCount())
        assertFalse(result.deferred)
    }

    @Test
    fun `being offline defers the sync rather than throwing`() = runTest {
        val store = FakeStore()
        val client = FakeSheetsClient(readError = SheetsError("offline", 0, SheetsErrorKind.NETWORK, true))
        val result = SyncEngine(client, store, now = { clock }).sync()

        assertTrue(result.deferred)
        assertNotNull(result.deferredReason)
    }
}
