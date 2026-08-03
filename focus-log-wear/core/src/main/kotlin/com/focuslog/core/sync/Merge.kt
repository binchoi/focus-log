package com.focuslog.core.sync

import com.focuslog.core.model.Versioned
import java.time.Instant

/**
 * Last-write-wins reduction over the append-only sheet log — a port of the web
 * app's `sync/merge.ts`.
 *
 * The sheet is never updated in place; reading means collapsing many rows per id
 * down to one. The reduction is idempotent (a retried, byte-identical row
 * collapses to one), deterministic across devices (the `deviceId` tie-break), and
 * convergent (merging is commutative and associative).
 */

/**
 * Parse an ISO-8601 instant to epoch millis, or null if unparseable.
 *
 * An unparseable timestamp must never silently win a conflict, so callers treat
 * null as "loses".
 */
private fun parseInstantMillis(value: String): Long? =
    try {
        Instant.parse(value).toEpochMilli()
    } catch (_: Exception) {
        null
    }

/**
 * Compare two versions of the same record. Positive means `a` wins.
 *
 * `updatedAt` is compared as a parsed instant, never as a string: ISO strings
 * only sort lexicographically when their precision matches, and
 * "2026-01-01T00:00:00Z" > "2026-01-01T00:00:00.000Z" as text ('Z' > '.') even
 * though they are the same moment.
 */
fun compareVersions(a: Versioned, b: Versioned): Int {
    val timeA = parseInstantMillis(a.updatedAt)
    val timeB = parseInstantMillis(b.updatedAt)

    if (timeA == null && timeB == null) return 0
    if (timeA == null) return -1
    if (timeB == null) return 1

    if (timeA != timeB) return if (timeA > timeB) 1 else -1

    // Same instant: break the tie on deviceId so every device agrees.
    if (a.deviceId != b.deviceId) return if (a.deviceId > b.deviceId) 1 else -1

    return 0
}

/** The winning version of two candidates. Returns `a` on an exact tie. */
fun <T : Versioned> pickWinner(a: T, b: T): T = if (compareVersions(b, a) > 0) b else a

/**
 * Collapse an append-only row set to the newest version of each record.
 * Tombstones are *kept*, not dropped, so a delete survives the reduce and
 * propagates to other devices. Filter with [visibleOnly] for display.
 */
fun <T : Versioned> reduceLatest(records: List<T>, id: (T) -> String): Map<String, T> {
    val latest = LinkedHashMap<String, T>()
    for (record in records) {
        val key = id(record)
        val existing = latest[key]
        latest[key] = if (existing == null) record else pickWinner(existing, record)
    }
    return latest
}

/** Live records only: tombstones removed. */
fun <T : Versioned> visibleOnly(records: Iterable<T>): List<T> = records.filter { !it.deleted }

data class MergeResult<T>(
    /** Newest version of every id seen on either side, tombstones included. */
    val merged: List<T>,
    /** Records whose winning version came from `remote` — what to persist locally. */
    val changedLocally: List<T>,
    /** Records whose winning version came from `local` — what still needs pushing. */
    val changedRemotely: List<T>,
)

/**
 * Merge the local mirror with what the sheet currently holds. A local edit made
 * offline naturally wins, because its `updatedAt` was stamped when the user made
 * it — the timestamps carry that, so no separate "pending" concept is needed.
 */
fun <T : Versioned> mergeRecords(local: List<T>, remote: List<T>, id: (T) -> String): MergeResult<T> {
    val localLatest = reduceLatest(local, id)
    val remoteLatest = reduceLatest(remote, id)

    val merged = ArrayList<T>()
    val changedLocally = ArrayList<T>()
    val changedRemotely = ArrayList<T>()

    val keys = LinkedHashSet<String>().apply {
        addAll(localLatest.keys)
        addAll(remoteLatest.keys)
    }

    for (key in keys) {
        val mine = localLatest[key]
        val theirs = remoteLatest[key]

        if (mine == null) {
            // Only the sheet has it: another device created it.
            merged.add(theirs!!)
            changedLocally.add(theirs)
            continue
        }
        if (theirs == null) {
            // Only we have it: created here and not yet pushed.
            merged.add(mine)
            changedRemotely.add(mine)
            continue
        }

        merged.add(pickWinner(mine, theirs))
        val decision = compareVersions(mine, theirs)
        when {
            decision < 0 -> changedLocally.add(theirs)
            decision > 0 -> changedRemotely.add(mine)
            // decision == 0: both sides already agree, nothing to do.
        }
    }

    return MergeResult(merged, changedLocally, changedRemotely)
}

/**
 * Rows that can be dropped when compacting the sheet: everything that is not the
 * winning version of its id.
 */
fun <T : Versioned> supersededCount(records: List<T>, id: (T) -> String): Int =
    records.size - reduceLatest(records, id).size
