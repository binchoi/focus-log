package com.focuslog.core.store

import com.focuslog.core.model.Goal
import com.focuslog.core.model.Session
import com.focuslog.core.model.Versioned
import com.focuslog.core.time.Time
import java.util.UUID

/**
 * Mutations against the local store — a port of `store/repo.ts`.
 *
 * Every mutation writes the record *and* its outbox op inside one [LocalStore.transaction].
 * That single transaction is the commit point the UI reports as "saved" — not the
 * HTTP response. If the watch dies immediately afterwards, the op is still
 * queued; if it is offline for a week, nothing is lost.
 */
class Repo(
    private val store: LocalStore,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val ids: () -> String = { UUID.randomUUID().toString() },
    private val deviceId: () -> String,
    private val timeZone: () -> String = { Time.currentTimeZone() },
) {

    companion object {
        /** Longest session we will accept. Guards against a runaway timer. */
        const val MAX_SESSION_SECONDS: Long = 24L * 60 * 60
    }

    // -- goals ---------------------------------------------------------------

    suspend fun createGoal(
        title: String,
        color: String = "#4caf50",
        weeklyTargetMinutes: Int = 0,
        sortOrder: Int = 0,
    ): Goal {
        val timestamp = Time.toIsoUtc(now())
        val goal = Goal(
            goalId = ids(),
            title = title.trim(),
            color = color,
            weeklyTargetMinutes = weeklyTargetMinutes,
            sortOrder = sortOrder,
            status = "active",
            createdAt = timestamp,
            updatedAt = timestamp,
            deleted = false,
            deviceId = deviceId(),
        )
        commit(OutboxEntity.GOAL, goal.goalId, goal) { store.putGoal(goal) }
        return goal
    }

    suspend fun updateGoal(goalId: String, patch: Goal.() -> Goal): Goal {
        val existing = store.getGoal(goalId) ?: throw IllegalArgumentException("No such goal: $goalId")
        val goal = existing.patch().copy(
            goalId = existing.goalId,
            createdAt = existing.createdAt,
            updatedAt = Time.toIsoUtc(now()),
            deviceId = deviceId(),
        )
        commit(OutboxEntity.GOAL, goal.goalId, goal) { store.putGoal(goal) }
        return goal
    }

    /** Soft-deletes a goal; the tombstone propagates the delete to other devices. */
    suspend fun deleteGoal(goalId: String): Goal =
        updateGoal(goalId) { copy(deleted = true, status = "archived") }

    // -- sessions ------------------------------------------------------------

    suspend fun logSession(
        goalId: String,
        startMillis: Long,
        endMillis: Long,
        note: String = "",
        source: String = "timer",
        durationSecondsOverride: Long? = null,
    ): Session {
        val tz = timeZone()
        val computed = Time.durationSeconds(startMillis, endMillis)
        val duration = durationSecondsOverride ?: computed
        require(duration >= 0) { "A session cannot have a negative duration." }
        require(duration <= MAX_SESSION_SECONDS) {
            "A session cannot exceed ${MAX_SESSION_SECONDS / 3600} hours. Trim it before logging."
        }
        // Keep start/end/duration mutually consistent when the duration is adjusted.
        val end = if (duration == computed) endMillis else startMillis + duration * 1000L

        val session = Session(
            logId = ids(),
            goalId = goalId,
            startUtc = Time.toIsoUtc(startMillis),
            endUtc = Time.toIsoUtc(end),
            durationSeconds = duration.toInt(),
            localDate = Time.localDateOf(startMillis, tz),
            tz = tz,
            note = note.trim(),
            source = source,
            updatedAt = Time.toIsoUtc(now()),
            deleted = false,
            deviceId = deviceId(),
        )
        commit(OutboxEntity.SESSION, session.logId, session) { store.putSession(session) }
        return session
    }

    suspend fun deleteSession(logId: String): Unit {
        val existing = store.getSession(logId) ?: throw IllegalArgumentException("No such session: $logId")
        val tombstone = existing.copy(
            deleted = true,
            updatedAt = Time.toIsoUtc(now()),
            deviceId = deviceId(),
        )
        commit(OutboxEntity.SESSION, logId, tombstone) { store.putSession(tombstone) }
    }

    // -- queries -------------------------------------------------------------

    suspend fun listGoals(): List<Goal> =
        store.allGoals()
            .filter { !it.deleted }
            .sortedWith(compareBy({ it.sortOrder }, { it.title }))

    suspend fun listSessions(
        goalId: String? = null,
        from: String? = null,
        to: String? = null,
    ): List<Session> =
        store.allSessions()
            .filter { !it.deleted }
            .filter { goalId == null || it.goalId == goalId }
            .filter { from == null || it.localDate >= from }
            .filter { to == null || it.localDate <= to }
            .sortedByDescending { it.startUtc }

    /** Total focused seconds per goal id. Computed locally, never from a formula. */
    suspend fun totalsByGoal(from: String? = null, to: String? = null): Map<String, Long> {
        val totals = LinkedHashMap<String, Long>()
        for (s in listSessions(from = from, to = to)) {
            totals[s.goalId] = (totals[s.goalId] ?: 0L) + s.durationSeconds
        }
        return totals
    }

    suspend fun pendingCount(): Int = store.outboxCount()

    // -- commit --------------------------------------------------------------

    /**
     * Applies the local write and enqueues the outbox op atomically. Repeated
     * edits of the same record collapse to one queued op — only the newest
     * version needs to reach the sheet — but an op currently being drained is
     * never discarded, so we don't lose a row the sync engine has already sent.
     */
    private suspend fun commit(
        entity: OutboxEntity,
        entityId: String,
        payload: Versioned,
        write: suspend () -> Unit,
    ) {
        store.transaction {
            write()
            val supersedable = store.outboxForEntity(entityId).filter { it.leasedUntil == null }
            if (supersedable.isNotEmpty()) {
                store.outboxDelete(supersedable.mapNotNull { it.opId })
            }
            store.outboxAdd(
                OutboxOp(
                    entity = entity,
                    entityId = entityId,
                    payload = payload,
                    createdAt = payload.updatedAt,
                    attempts = 0,
                ),
            )
        }
    }
}
