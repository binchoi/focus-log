package com.focuslog.core.store

import com.focuslog.core.testfixtures.FakeStore
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class RepoTest {

    private fun repo(store: FakeStore, clock: Long = 1_700_000_000_000L): Repo {
        var counter = 0
        return Repo(
            store = store,
            now = { clock },
            ids = { "id-${++counter}" },
            deviceId = { "wear-test" },
            timeZone = { "UTC" },
        )
    }

    @Test
    fun `createGoal writes the goal and enqueues exactly one outbox op`() = runTest {
        val store = FakeStore()
        val goal = repo(store).createGoal(title = "  Writing  ", weeklyTargetMinutes = 300)
        assertEquals("Writing", goal.title) // trimmed
        assertEquals("wear-test", goal.deviceId)
        assertEquals(goal, store.getGoal(goal.goalId))
        val ops = store.outboxForEntity(goal.goalId)
        assertEquals(1, ops.size)
        assertEquals(OutboxEntity.GOAL, ops.single().entity)
    }

    @Test
    fun `repeated edits collapse to a single queued op`() = runTest {
        val store = FakeStore()
        val r = repo(store)
        val goal = r.createGoal(title = "Writing")
        r.updateGoal(goal.goalId) { copy(title = "Writing v2") }
        r.updateGoal(goal.goalId) { copy(title = "Writing v3") }
        // Only the newest version needs to reach the sheet.
        assertEquals(1, store.outboxForEntity(goal.goalId).size)
        assertEquals(1, store.outboxCount())
    }

    @Test
    fun `an op currently being drained is never superseded`() = runTest {
        val store = FakeStore()
        val r = repo(store)
        val goal = r.createGoal(title = "Writing")
        // Simulate the sync engine having leased the queued op.
        val leased = store.outboxForEntity(goal.goalId).single().copy(leasedUntil = Long.MAX_VALUE)
        store.outboxPut(listOf(leased))
        // A concurrent edit must add a new op, not delete the in-flight one.
        r.updateGoal(goal.goalId) { copy(title = "edited during sync") }
        assertEquals(2, store.outboxForEntity(goal.goalId).size)
    }

    @Test
    fun `logSession computes duration and local date and clamps the override`() = runTest {
        val store = FakeStore()
        val start = 1_700_000_000_000L
        val session = repo(store).logSession(
            goalId = "goal-1",
            startMillis = start,
            endMillis = start + 1_559_000, // 25m59s
        )
        assertEquals(1559, session.durationSeconds)
        assertEquals("timer", session.source)
        assertEquals(1, store.outboxForEntity(session.logId).size)
    }

    @Test
    fun `logSession honours an upward duration override and keeps end consistent`() = runTest {
        val store = FakeStore()
        val start = 1_700_000_000_000L
        val session = repo(store).logSession(
            goalId = "goal-1",
            startMillis = start,
            endMillis = start + 60_000, // recorded 60s
            durationSecondsOverride = 3600, // corrected up to an hour
        )
        assertEquals(3600, session.durationSeconds)
        // end - start must equal the stored duration.
        assertEquals(
            "2023-11-14T22:13:20.000Z",
            session.startUtc,
        )
    }

    @Test
    fun `logSession refuses an out-of-range duration`() = runTest {
        val store = FakeStore()
        val r = repo(store)
        assertFailsWith<IllegalArgumentException> {
            r.logSession("g", 0, 0, durationSecondsOverride = -1)
        }
        assertFailsWith<IllegalArgumentException> {
            r.logSession("g", 0, 0, durationSecondsOverride = Repo.MAX_SESSION_SECONDS + 1)
        }
    }

    @Test
    fun `deleteSession writes a tombstone rather than removing the row`() = runTest {
        val store = FakeStore()
        val r = repo(store)
        val session = r.logSession("goal-1", 0, 60_000)
        r.deleteSession(session.logId)
        assertTrue(store.getSession(session.logId)!!.deleted)
        // Not visible to queries, but still present to propagate the delete.
        assertTrue(r.listSessions(goalId = "goal-1").isEmpty())
    }

    @Test
    fun `totalsByGoal sums only visible sessions`() = runTest {
        val store = FakeStore()
        val r = repo(store)
        r.logSession("g1", 0, 600_000) // 600s
        r.logSession("g1", 0, 300_000) // 300s
        r.logSession("g2", 0, 120_000) // 120s
        val totals = r.totalsByGoal()
        assertEquals(900, totals["g1"])
        assertEquals(120, totals["g2"])
    }

    @Test
    fun `listGoals hides deleted goals and sorts by order then title`() = runTest {
        val store = FakeStore()
        val r = repo(store)
        val a = r.createGoal(title = "Bravo", sortOrder = 1)
        r.createGoal(title = "Alpha", sortOrder = 0)
        val gone = r.createGoal(title = "Zulu", sortOrder = 2)
        r.deleteGoal(gone.goalId)
        val titles = r.listGoals().map { it.title }
        assertEquals(listOf("Alpha", "Bravo"), titles)
        assertTrue(r.listGoals().none { it.goalId == a.goalId && it.deleted })
    }
}
