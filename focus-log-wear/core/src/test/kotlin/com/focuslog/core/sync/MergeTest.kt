package com.focuslog.core.sync

import com.focuslog.core.model.Versioned
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Port of `sync/merge.test.ts` — the executable spec for LWW convergence. */
class MergeTest {

    private data class Rec(
        val id: String,
        val value: String,
        override val updatedAt: String,
        override val deleted: Boolean = false,
        override val deviceId: String = "dev-a",
    ) : Versioned

    private val byId = { r: Rec -> r.id }

    private fun rec(
        id: String,
        value: String,
        updatedAt: String,
        deleted: Boolean = false,
        deviceId: String = "dev-a",
    ) = Rec(id, value, updatedAt, deleted, deviceId)

    // --- compareVersions -----------------------------------------------------

    @Test
    fun `orders by instant`() {
        val older = rec("a", "1", "2026-07-29T10:00:00.000Z")
        val newer = rec("a", "2", "2026-07-29T10:00:01.000Z")
        assertTrue(compareVersions(newer, older) > 0)
        assertTrue(compareVersions(older, newer) < 0)
    }

    @Test
    fun `compares instants, not strings, across differing ISO precision`() {
        val withMs = rec("a", "ms", "2026-07-29T10:00:00.000Z")
        val withoutMs = rec("a", "no-ms", "2026-07-29T10:00:00Z")
        // The trap: as text, "…00:00Z" > "…00:00.000Z".
        assertTrue("2026-07-29T10:00:00Z" > "2026-07-29T10:00:00.000Z")
        assertEquals(0, compareVersions(withMs, withoutMs))
    }

    @Test
    fun `breaks an exact tie on device_id so all devices agree`() {
        val a = rec("x", "from-a", "2026-07-29T10:00:00.000Z", deviceId = "dev-a")
        val b = rec("x", "from-b", "2026-07-29T10:00:00.000Z", deviceId = "dev-b")
        assertTrue(compareVersions(b, a) > 0)
        assertTrue(compareVersions(a, b) < 0)
        assertSame(b, pickWinner(a, b))
        assertSame(b, pickWinner(b, a))
    }

    @Test
    fun `treats a byte-identical row as an exact tie`() {
        val original = rec("x", "v", "2026-07-29T10:00:00.000Z")
        val duplicate = original.copy()
        assertEquals(0, compareVersions(original, duplicate))
    }

    @Test
    fun `never lets an unparseable timestamp win`() {
        val good = rec("x", "good", "2026-07-29T10:00:00.000Z")
        val bad = rec("x", "bad", "not a date")
        assertTrue(compareVersions(bad, good) < 0)
        assertSame(good, pickWinner(good, bad))
        assertSame(good, pickWinner(bad, good))
    }

    @Test
    fun `returns 0 when both timestamps are unparseable`() {
        assertEquals(0, compareVersions(rec("x", "a", "nope"), rec("x", "b", "also nope")))
    }

    // --- reduceLatest --------------------------------------------------------

    @Test
    fun `collapses an append-only log to the newest version per id`() {
        val rows = listOf(
            rec("a", "v1", "2026-07-29T10:00:00.000Z"),
            rec("b", "other", "2026-07-29T10:00:00.000Z"),
            rec("a", "v2", "2026-07-29T11:00:00.000Z"),
            rec("a", "v3", "2026-07-29T12:00:00.000Z"),
        )
        val latest = reduceLatest(rows, byId)
        assertEquals(2, latest.size)
        assertEquals("v3", latest["a"]!!.value)
        assertEquals("other", latest["b"]!!.value)
    }

    @Test
    fun `is order-independent`() {
        val rows = listOf(
            rec("a", "v1", "2026-07-29T10:00:00.000Z"),
            rec("a", "v3", "2026-07-29T12:00:00.000Z"),
            rec("a", "v2", "2026-07-29T11:00:00.000Z"),
        )
        for (permutation in listOf(rows, rows.reversed(), listOf(rows[1], rows[0], rows[2]))) {
            assertEquals("v3", reduceLatest(permutation, byId)["a"]!!.value)
        }
    }

    @Test
    fun `de-duplicates an idempotent retry to a single record`() {
        val row = rec("a", "v1", "2026-07-29T10:00:00.000Z")
        val latest = reduceLatest(listOf(row, row.copy(), row.copy()), byId)
        assertEquals(1, latest.size)
        assertEquals("v1", latest["a"]!!.value)
    }

    @Test
    fun `keeps a tombstone so the delete can propagate`() {
        val rows = listOf(
            rec("a", "v1", "2026-07-29T10:00:00.000Z"),
            rec("a", "v1", "2026-07-29T11:00:00.000Z", deleted = true),
        )
        val latest = reduceLatest(rows, byId)
        assertTrue(latest["a"]!!.deleted)
        assertEquals(emptyList(), visibleOnly(latest.values))
    }

    @Test
    fun `lets a later undelete revive a tombstoned record`() {
        val rows = listOf(
            rec("a", "v1", "2026-07-29T11:00:00.000Z", deleted = true),
            rec("a", "revived", "2026-07-29T12:00:00.000Z", deleted = false),
        )
        assertEquals(1, visibleOnly(reduceLatest(rows, byId).values).size)
    }

    @Test
    fun `handles an empty input`() {
        assertEquals(0, reduceLatest(emptyList<Rec>(), byId).size)
    }

    // --- mergeRecords --------------------------------------------------------

    @Test
    fun `adopts a record only the sheet has`() {
        val remote = listOf(rec("a", "from-other-device", "2026-07-29T10:00:00.000Z"))
        val result = mergeRecords(emptyList(), remote, byId)
        assertEquals(remote, result.merged)
        assertEquals(remote, result.changedLocally)
        assertEquals(emptyList(), result.changedRemotely)
    }

    @Test
    fun `queues a record only we have`() {
        val local = listOf(rec("a", "made-offline", "2026-07-29T10:00:00.000Z"))
        val result = mergeRecords(local, emptyList(), byId)
        assertEquals(local, result.merged)
        assertEquals(local, result.changedRemotely)
        assertEquals(emptyList(), result.changedLocally)
    }

    @Test
    fun `lets an offline local edit win over a stale remote row`() {
        val local = listOf(rec("a", "edited-offline", "2026-07-29T12:00:00.000Z"))
        val remote = listOf(rec("a", "stale", "2026-07-29T10:00:00.000Z"))
        val result = mergeRecords(local, remote, byId)
        assertEquals("edited-offline", result.merged[0].value)
        assertEquals(1, result.changedRemotely.size)
        assertEquals(0, result.changedLocally.size)
    }

    @Test
    fun `accepts a newer remote edit from another device`() {
        val local = listOf(rec("a", "mine", "2026-07-29T10:00:00.000Z"))
        val remote = listOf(rec("a", "theirs", "2026-07-29T12:00:00.000Z", deviceId = "dev-b"))
        val result = mergeRecords(local, remote, byId)
        assertEquals("theirs", result.merged[0].value)
        assertEquals(1, result.changedLocally.size)
        assertEquals(0, result.changedRemotely.size)
    }

    @Test
    fun `reports no change when both sides already agree`() {
        val row = rec("a", "same", "2026-07-29T10:00:00.000Z")
        val result = mergeRecords(listOf(row), listOf(row.copy()), byId)
        assertEquals(1, result.merged.size)
        assertEquals(emptyList(), result.changedLocally)
        assertEquals(emptyList(), result.changedRemotely)
    }

    @Test
    fun `propagates a remote delete`() {
        val local = listOf(rec("a", "v", "2026-07-29T10:00:00.000Z"))
        val remote = listOf(rec("a", "v", "2026-07-29T11:00:00.000Z", deleted = true))
        val result = mergeRecords(local, remote, byId)
        assertTrue(result.changedLocally[0].deleted)
        assertEquals(emptyList(), visibleOnly(result.merged))
    }

    @Test
    fun `propagates a local delete made offline`() {
        val local = listOf(rec("a", "v", "2026-07-29T11:00:00.000Z", deleted = true))
        val remote = listOf(rec("a", "v", "2026-07-29T10:00:00.000Z"))
        val result = mergeRecords(local, remote, byId)
        assertTrue(result.changedRemotely[0].deleted)
    }

    @Test
    fun `resolves a simultaneous two-device edit identically on both devices`() {
        val fromA = rec("a", "A-version", "2026-07-29T10:00:00.000Z", deviceId = "dev-a")
        val fromB = rec("a", "B-version", "2026-07-29T10:00:00.000Z", deviceId = "dev-b")
        val asSeenOnA = mergeRecords(listOf(fromA), listOf(fromB), byId)
        val asSeenOnB = mergeRecords(listOf(fromB), listOf(fromA), byId)
        assertEquals("B-version", asSeenOnA.merged[0].value)
        assertEquals("B-version", asSeenOnB.merged[0].value)
        assertEquals(asSeenOnA.merged, asSeenOnB.merged)
    }

    @Test
    fun `is commutative for the merged set across random orderings`() {
        val ids = listOf("a", "b", "c", "d", "e")
        val devices = listOf("dev-a", "dev-b", "dev-c")
        fun build(seed: Int): List<Rec> = ids.flatMapIndexed { i, id ->
            (0 until 3).map { v ->
                val minute = (seed * 7 + i * 3 + v * 5) % 60
                rec(
                    id,
                    "$id-$v",
                    "2026-07-29T10:${minute.toString().padStart(2, '0')}:00.000Z",
                    deviceId = devices[(i + v + seed) % devices.size],
                    deleted = (seed + i + v) % 5 == 0,
                )
            }
        }

        val left = build(1)
        val right = build(2)

        fun normalise(records: List<Rec>) =
            records.sortedBy { it.id }.map { "${it.id}:${it.value}:${it.deleted}" }

        val forward = mergeRecords(left, right, byId)
        val backward = mergeRecords(right, left, byId)
        assertEquals(normalise(forward.merged), normalise(backward.merged))

        val reshuffled = mergeRecords(left.reversed(), right.reversed(), byId)
        assertEquals(normalise(forward.merged), normalise(reshuffled.merged))
    }

    @Test
    fun `converges after a second round-trip`() {
        val local = listOf(rec("a", "mine", "2026-07-29T12:00:00.000Z"))
        val remote = listOf(rec("a", "theirs", "2026-07-29T10:00:00.000Z"))
        val first = mergeRecords(local, remote, byId)
        val second = mergeRecords(first.merged, remote, byId)
        assertEquals(first.merged, second.merged)
        val third = mergeRecords(first.merged, first.merged, byId)
        assertEquals(emptyList(), third.changedLocally)
        assertEquals(emptyList(), third.changedRemotely)
    }

    // --- supersededCount -----------------------------------------------------

    @Test
    fun `counts rows that compaction would remove`() {
        val rows = listOf(
            rec("a", "v1", "2026-07-29T10:00:00.000Z"),
            rec("a", "v2", "2026-07-29T11:00:00.000Z"),
            rec("a", "v3", "2026-07-29T12:00:00.000Z"),
            rec("b", "only", "2026-07-29T10:00:00.000Z"),
        )
        assertEquals(2, supersededCount(rows, byId))
    }

    @Test
    fun `is zero for an already-compact set`() {
        assertEquals(0, supersededCount(listOf(rec("a", "v", "2026-07-29T10:00:00.000Z")), byId))
    }
}
