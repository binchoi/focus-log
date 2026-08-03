package com.focuslog.wear.data.room

import androidx.room.withTransaction
import com.focuslog.core.model.Goal
import com.focuslog.core.model.Session
import com.focuslog.core.store.LocalStore
import com.focuslog.core.store.OutboxOp

/**
 * [LocalStore] backed by Room. [transaction] delegates to Room's own atomic
 * transaction, so a mutation and its outbox op commit together — the local-first
 * guarantee the whole design rests on.
 */
class RoomLocalStore(private val db: FocusLogDatabase) : LocalStore {

    override suspend fun getGoal(goalId: String): Goal? = db.goals().get(goalId)?.toModel()
    override suspend fun allGoals(): List<Goal> = db.goals().all().map { it.toModel() }
    override suspend fun putGoal(goal: Goal) = db.goals().upsert(listOf(goal.toEntity()))
    override suspend fun putGoals(goals: List<Goal>) = db.goals().upsert(goals.map { it.toEntity() })

    override suspend fun getSession(logId: String): Session? = db.sessions().get(logId)?.toModel()
    override suspend fun allSessions(): List<Session> = db.sessions().all().map { it.toModel() }
    override suspend fun putSession(session: Session) = db.sessions().upsert(listOf(session.toEntity()))
    override suspend fun putSessions(sessions: List<Session>) =
        db.sessions().upsert(sessions.map { it.toEntity() })

    override suspend fun outboxAll(): List<OutboxOp> = db.outbox().all().map { it.toModel() }
    override suspend fun outboxForEntity(entityId: String): List<OutboxOp> =
        db.outbox().forEntity(entityId).map { it.toModel() }

    override suspend fun outboxAdd(op: OutboxOp): Long = db.outbox().insert(op.toEntity())
    override suspend fun outboxPut(ops: List<OutboxOp>) = db.outbox().upsert(ops.map { it.toEntity() })
    override suspend fun outboxDelete(opIds: List<Long>) = db.outbox().delete(opIds)
    override suspend fun outboxCount(): Int = db.outbox().count()

    override suspend fun getMeta(key: String): String? = db.syncMeta().get(key)
    override suspend fun putMeta(key: String, value: String) = db.syncMeta().put(SyncMetaEntity(key, value))

    override suspend fun <T> transaction(block: suspend () -> T): T = db.withTransaction { block() }
}
