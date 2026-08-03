package com.focuslog.core.store

import com.focuslog.core.model.Goal
import com.focuslog.core.model.Session
import com.focuslog.core.model.Versioned

/**
 * The local store contract. IndexedDB is the web app's source of truth; on the
 * watch that role is Room. The `:core` layer depends only on this interface, so
 * the repo and sync engine are testable against an in-memory fake.
 *
 * [transaction] must be atomic in the real (Room) implementation — the whole
 * point of the local-first design is that a mutation and its outbox op commit
 * together, so a crash can never leave one without the other.
 */
interface LocalStore {
    suspend fun getGoal(goalId: String): Goal?
    suspend fun allGoals(): List<Goal>
    suspend fun putGoal(goal: Goal)
    suspend fun putGoals(goals: List<Goal>)

    suspend fun getSession(logId: String): Session?
    suspend fun allSessions(): List<Session>
    suspend fun putSession(session: Session)
    suspend fun putSessions(sessions: List<Session>)

    suspend fun outboxAll(): List<OutboxOp>
    suspend fun outboxForEntity(entityId: String): List<OutboxOp>
    suspend fun outboxAdd(op: OutboxOp): Long
    suspend fun outboxPut(ops: List<OutboxOp>)
    suspend fun outboxDelete(opIds: List<Long>)
    suspend fun outboxCount(): Int

    suspend fun getMeta(key: String): String?
    suspend fun putMeta(key: String, value: String)

    /** Runs [block] atomically. */
    suspend fun <T> transaction(block: suspend () -> T): T
}

enum class OutboxEntity { GOAL, SESSION }

/**
 * A pending mutation waiting to reach the spreadsheet. The payload is the full
 * row to append — the sheet is append-only, so there is no diff to apply.
 */
data class OutboxOp(
    val opId: Long? = null,
    val entity: OutboxEntity,
    /** goalId or logId. Lets us collapse repeated edits of one record. */
    val entityId: String,
    val payload: Versioned,
    val createdAt: String,
    val attempts: Int = 0,
    val lastError: String? = null,
    /** Set while the op is being drained, so a concurrent sync skips it. */
    val leasedUntil: Long? = null,
)

/** Keys used in the syncMeta table. */
object SyncMetaKeys {
    const val LAST_PULL_AT = "last_pull_at"
    const val LAST_PUSH_AT = "last_push_at"
    const val LAST_ERROR = "last_error"
    const val SCHEMA_VERSION = "schema_version"
}
