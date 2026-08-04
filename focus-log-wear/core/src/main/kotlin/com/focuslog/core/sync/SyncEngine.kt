package com.focuslog.core.sync

import com.focuslog.core.model.Goal
import com.focuslog.core.model.Session
import com.focuslog.core.sheets.Cell
import com.focuslog.core.sheets.Ranges
import com.focuslog.core.sheets.SheetsClient
import com.focuslog.core.sheets.SheetsError
import com.focuslog.core.sheets.goalToRow
import com.focuslog.core.sheets.parseGoalRows
import com.focuslog.core.sheets.parseMetaRows
import com.focuslog.core.sheets.parseSessionRows
import com.focuslog.core.sheets.sessionToRow
import com.focuslog.core.sheets.ParseFailure
import com.focuslog.core.sheets.SCHEMA_VERSION
import com.focuslog.core.store.LocalStore
import com.focuslog.core.store.OutboxEntity
import com.focuslog.core.store.OutboxOp
import com.focuslog.core.store.SyncMetaKeys
import com.focuslog.core.time.Time
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Sync orchestrator — a port of `sync/engine.ts`: push, then pull, then merge.
 *
 * The outbox is drained under a *lease* rather than deleted optimistically. A
 * naive "delete then send" loses work if the process dies mid-flight; a naive
 * "send then delete" can double-send. Leasing plus client-minted ids means the
 * worst case is an identical row appended twice, which the reducer collapses — so
 * a lost response is harmless. Being offline is an ordinary state here, not an
 * exception: a retryable failure defers, it does not throw.
 */
class SyncEngine(
    private val client: SheetsClient,
    private val store: LocalStore,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val leaseMs: Long = 60_000,
    private val maxAttempts: Int = 10,
) {
    /** Serialises runs so two triggers cannot drain the outbox concurrently. */
    private val runLock = Mutex()

    suspend fun sync(): SyncResult = runLock.withLock { run() }

    private suspend fun run(): SyncResult {
        // Push first: local work is what we can least afford to lose, and pushing
        // before pulling means the merge sees our own rows and won't report them
        // as remote changes.
        val pushOutcome = push()
        var deferredReason = pushOutcome.deferredReason

        var pulled = PullResult(Pulled(0, 0), Malformed(emptyList(), emptyList()), null)
        try {
            pulled = pull()
        } catch (error: SheetsError) {
            // Offline / 429 / 5xx: defer, don't fail. The queue is intact.
            if (error.retryable) {
                deferredReason = error.message
                setMeta(SyncMetaKeys.LAST_ERROR, error.message ?: "sync deferred")
            } else {
                throw error
            }
        }

        return SyncResult(
            pulled = pulled.pulled,
            pushed = pushOutcome.pushed,
            stillPending = store.outboxCount(),
            malformed = pulled.malformed,
            schemaVersion = pulled.schemaVersion,
            deferred = deferredReason != null,
            deferredReason = deferredReason,
        )
    }

    // -- push ----------------------------------------------------------------

    suspend fun push(): PushOutcome {
        val claimed = claim()
        if (claimed.isEmpty()) return PushOutcome(0, null)

        val goalOps = claimed.filter { it.entity == OutboxEntity.GOAL }
        val sessionOps = claimed.filter { it.entity == OutboxEntity.SESSION }

        // Goals go first: a session referencing a goal the sheet hasn't seen yet
        // would look like an orphan to anyone reading mid-sync.
        val goals = pushBatch(goalOps, Ranges.goals) { goalToRow(it.payload as Goal) }
        val sessions = pushBatch(sessionOps, Ranges.sessions) { sessionToRow(it.payload as Session) }

        val pushed = goals.pushed + sessions.pushed
        if (pushed > 0) setMeta(SyncMetaKeys.LAST_PUSH_AT, Time.toIsoUtc(now()))
        return PushOutcome(pushed, goals.deferredReason ?: sessions.deferredReason)
    }

    /**
     * Marks ops in-flight so a concurrent run skips them. Expired leases are
     * reclaimed, which is how a run that died mid-push gets its work retried.
     */
    private suspend fun claim(): List<OutboxOp> {
        val nowMs = now()
        return store.transaction {
            val all = store.outboxAll().sortedBy { it.opId ?: Long.MAX_VALUE }
            val available = all.filter {
                (it.leasedUntil == null || it.leasedUntil < nowMs) && it.attempts < maxAttempts
            }
            if (available.isEmpty()) {
                emptyList()
            } else {
                store.outboxPut(available.map { it.copy(leasedUntil = nowMs + leaseMs) })
                available
            }
        }
    }

    private suspend fun pushBatch(
        ops: List<OutboxOp>,
        range: String,
        toRow: (OutboxOp) -> List<Cell>,
    ): BatchResult {
        if (ops.isEmpty()) return BatchResult(0, null)
        try {
            client.append(range, ops.map(toRow))
        } catch (error: SheetsError) {
            releaseWithError(ops, error)
            // Retryable (offline, 429, 5xx) is expected, not exceptional: the ops
            // stay queued and the next trigger picks them up. Anything else is a
            // real misconfiguration the caller must surface.
            if (error.retryable) return BatchResult(0, error.message)
            throw error
        }
        // Confirmed appended: only now is it safe to forget the op.
        store.outboxDelete(ops.mapNotNull { it.opId })
        return BatchResult(ops.size, null)
    }

    private suspend fun releaseWithError(ops: List<OutboxOp>, error: Throwable) {
        val message = error.message ?: error.toString()
        store.outboxPut(
            ops.map { it.copy(attempts = it.attempts + 1, lastError = message, leasedUntil = null) },
        )
        setMeta(SyncMetaKeys.LAST_ERROR, message)
    }

    // -- pull ----------------------------------------------------------------

    suspend fun pull(): PullResult {
        val raw = client.readAll()

        val remoteGoals = parseGoalRows(raw.goals)
        val remoteSessions = parseSessionRows(raw.sessions)
        val meta = parseMetaRows(raw.meta)
        val schemaVersion = (meta[SyncMetaKeys.SCHEMA_VERSION] ?: meta["schema_version"])?.toIntOrNull()

        val localGoals = store.allGoals()
        val localSessions = store.allSessions()

        val goalMerge = mergeRecords(localGoals, remoteGoals.records) { it.goalId }
        val sessionMerge = mergeRecords(localSessions, remoteSessions.records) { it.logId }

        // Only write back what actually changed, so a no-op sync doesn't churn
        // the store and wake every observer.
        store.transaction {
            if (goalMerge.changedLocally.isNotEmpty()) store.putGoals(goalMerge.changedLocally)
            if (sessionMerge.changedLocally.isNotEmpty()) store.putSessions(sessionMerge.changedLocally)
        }

        setMeta(SyncMetaKeys.LAST_PULL_AT, Time.toIsoUtc(now()))

        return PullResult(
            pulled = Pulled(goalMerge.changedLocally.size, sessionMerge.changedLocally.size),
            malformed = Malformed(remoteGoals.failures, remoteSessions.failures),
            schemaVersion = schemaVersion,
        )
    }

    /** Ops that exhausted their retries and need the user to intervene. */
    suspend fun stuckOps(): List<OutboxOp> = store.outboxAll().filter { it.attempts >= maxAttempts }

    private suspend fun setMeta(key: String, value: String) = store.putMeta(key, value)
}

fun isSchemaCompatible(remoteVersion: Int?): Boolean =
    // An older sheet is fine to read and write — the app just leaves newer,
    // additive features (the `active` tab) off until it is migrated. Only a
    // *newer* sheet is refused, since writing it could drop unknown columns.
    remoteVersion == null || remoteVersion <= SCHEMA_VERSION

data class Pulled(val goals: Int, val sessions: Int)
data class Malformed(val goals: List<ParseFailure>, val sessions: List<ParseFailure>)

data class PullResult(val pulled: Pulled, val malformed: Malformed, val schemaVersion: Int?)

data class PushOutcome(val pushed: Int, val deferredReason: String?)
private data class BatchResult(val pushed: Int, val deferredReason: String?)

data class SyncResult(
    val pulled: Pulled,
    val pushed: Int,
    val stillPending: Int,
    val malformed: Malformed,
    val schemaVersion: Int?,
    val deferred: Boolean,
    val deferredReason: String?,
)
