package com.focuslog.core.sync

import com.focuslog.core.model.ActiveTimer
import com.focuslog.core.sheets.ACTIVE_COLUMNS
import com.focuslog.core.sheets.Ranges
import com.focuslog.core.sheets.SheetRead
import com.focuslog.core.sheets.activeToRow
import com.focuslog.core.sheets.headerRow
import com.focuslog.core.store.OutboxEntity
import com.focuslog.core.store.Repo
import com.focuslog.core.store.SyncMetaKeys
import com.focuslog.core.testfixtures.FakeSheetsClient
import com.focuslog.core.testfixtures.FakeStore
import com.focuslog.core.timer.Reconciliation
import com.focuslog.core.timer.Segment
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Wear-side mirror of the web engine's cross-device active-timer tests. */
class ActiveSyncTest {

    private val clock = 1_700_000_000_000L

    private class FakeBridge(var local: ActiveTimer? = null) : ActiveBridge {
        val applied = mutableListOf<Reconciliation>()
        override suspend fun readLocal(): ActiveTimer? = local
        override suspend fun apply(result: Reconciliation) { applied.add(result) }
    }

    private fun timer(logId: String, deleted: Boolean = false) = ActiveTimer(
        logId = logId,
        goalId = "g1",
        segments = listOf(Segment(clock, null)),
        note = "",
        updatedAt = "2026-07-29T10:00:00.000Z",
        deleted = deleted,
        deviceId = "wear-test",
    )

    private fun metaRows(version: String) =
        listOf(listOf<Any?>("key", "value"), listOf<Any?>("schema_version", version))

    @Test
    fun `pushes the active row to the active tab on a v2 sheet`() = runTest {
        val store = FakeStore()
        store.putMeta(SyncMetaKeys.SCHEMA_VERSION, "2") // learned by a prior pull
        Repo(store, now = { clock }, deviceId = { "wear-test" }).enqueueActive(timer("L-mine"))

        val client = FakeSheetsClient()
        SyncEngine(client, store, now = { clock }, active = FakeBridge()).push()

        assertTrue(client.appended[Ranges.active]?.isNotEmpty() == true)
        assertEquals(0, store.outboxCount())
    }

    @Test
    fun `pulls a remote timer and hands the reconciliation to the bridge`() = runTest {
        val store = FakeStore()
        val remote = timer("L-remote")
        val client = FakeSheetsClient(
            readResult = SheetRead(goals = emptyList(), sessions = emptyList(), meta = metaRows("2")),
            activeTab = listOf(headerRow(ACTIVE_COLUMNS)) + listOf(activeToRow(remote)),
        )
        val bridge = FakeBridge(local = null) // idle on this device

        SyncEngine(client, store, now = { clock }, active = bridge).pull()

        assertEquals(1, bridge.applied.size)
        assertEquals("L-remote", bridge.applied[0].local?.logId)
        assertTrue(bridge.applied[0].changed)
    }

    @Test
    fun `stays off on a v1 sheet - never reconciles and drops a stray active op`() = runTest {
        val store = FakeStore()
        Repo(store, now = { clock }, deviceId = { "wear-test" }).enqueueActive(timer("L-mine"))
        val client = FakeSheetsClient(
            readResult = SheetRead(goals = emptyList(), sessions = emptyList(), meta = metaRows("1")),
        )
        val bridge = FakeBridge(local = timer("L-mine"))

        val result = SyncEngine(client, store, now = { clock }, active = bridge).sync()

        assertTrue(bridge.applied.isEmpty()) // schema < 2 → no reconcile
        assertEquals(0, store.outboxCount()) // undeliverable active op dropped, not stuck
        assertEquals(false, result.deferred)
        assertTrue(client.appended[Ranges.active].isNullOrEmpty()) // never appended
    }

    @Test
    fun `does not collapse a session and an active row that share a logId`() = runTest {
        val store = FakeStore()
        val repo = Repo(store, now = { clock }, ids = { "shared" }, deviceId = { "wear-test" }, timeZone = { "UTC" })
        // logSession mints id "shared"; then the finalising timer's tombstone reuses it.
        repo.logSession("g1", clock, clock + 60_000)
        repo.enqueueActive(timer("shared", deleted = true))

        val entities = store.outboxAll().map { it.entity }.toSet()
        assertEquals(setOf(OutboxEntity.SESSION, OutboxEntity.ACTIVE), entities)
    }
}
