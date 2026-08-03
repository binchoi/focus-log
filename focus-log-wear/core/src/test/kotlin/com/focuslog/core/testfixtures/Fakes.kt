package com.focuslog.core.testfixtures

import com.focuslog.core.model.Goal
import com.focuslog.core.model.Session
import com.focuslog.core.sheets.Cell
import com.focuslog.core.sheets.Row
import com.focuslog.core.sheets.SheetRead
import com.focuslog.core.sheets.SheetsClient
import com.focuslog.core.sheets.SheetsError
import com.focuslog.core.store.LocalStore
import com.focuslog.core.store.OutboxOp

/** In-memory [LocalStore]. Single-threaded, so [transaction] is trivially atomic. */
class FakeStore : LocalStore {
    private val goals = LinkedHashMap<String, Goal>()
    private val sessions = LinkedHashMap<String, Session>()
    private val outbox = ArrayList<OutboxOp>()
    private val meta = LinkedHashMap<String, String>()
    private var nextOpId = 1L

    override suspend fun getGoal(goalId: String): Goal? = goals[goalId]
    override suspend fun allGoals(): List<Goal> = goals.values.toList()
    override suspend fun putGoal(goal: Goal) { goals[goal.goalId] = goal }
    override suspend fun putGoals(goals: List<Goal>) { goals.forEach { this.goals[it.goalId] = it } }

    override suspend fun getSession(logId: String): Session? = sessions[logId]
    override suspend fun allSessions(): List<Session> = sessions.values.toList()
    override suspend fun putSession(session: Session) { sessions[session.logId] = session }
    override suspend fun putSessions(sessions: List<Session>) {
        sessions.forEach { this.sessions[it.logId] = it }
    }

    override suspend fun outboxAll(): List<OutboxOp> = outbox.toList()
    override suspend fun outboxForEntity(entityId: String): List<OutboxOp> =
        outbox.filter { it.entityId == entityId }

    override suspend fun outboxAdd(op: OutboxOp): Long {
        val id = nextOpId++
        outbox.add(op.copy(opId = id))
        return id
    }

    override suspend fun outboxPut(ops: List<OutboxOp>) {
        for (op in ops) {
            val index = outbox.indexOfFirst { it.opId == op.opId }
            if (index >= 0) outbox[index] = op else outbox.add(op)
        }
    }

    override suspend fun outboxDelete(opIds: List<Long>) {
        val remove = opIds.toSet()
        outbox.removeAll { it.opId in remove }
    }

    override suspend fun outboxCount(): Int = outbox.size

    override suspend fun getMeta(key: String): String? = meta[key]
    override suspend fun putMeta(key: String, value: String) { meta[key] = value }

    override suspend fun <T> transaction(block: suspend () -> T): T = block()
}

/**
 * In-memory [SheetsClient]. Records appended rows per range and can be told to
 * fail reads or writes with a chosen [SheetsError].
 */
class FakeSheetsClient(
    var readResult: SheetRead = SheetRead(emptyList(), emptyList(), emptyList()),
    var readError: SheetsError? = null,
    var appendError: SheetsError? = null,
) : SheetsClient {
    val appended = LinkedHashMap<String, MutableList<List<Cell>>>()
    /** Ranges in the order append() was called, so ordering can be asserted. */
    val appendOrder = ArrayList<String>()

    override suspend fun readAll(): SheetRead {
        readError?.let { throw it }
        return readResult
    }

    override suspend fun append(range: String, rows: List<List<Cell>>) {
        appendError?.let { throw it }
        appendOrder.add(range)
        appended.getOrPut(range) { ArrayList() }.addAll(rows)
    }
}

/** Helper: build a sheet values block (header + data rows) from records. */
fun sheetValues(header: List<String>, rows: List<List<Cell>>): List<Row> =
    listOf<Row>(header) + rows
