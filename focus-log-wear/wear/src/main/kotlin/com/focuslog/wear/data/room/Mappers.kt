package com.focuslog.wear.data.room

import com.focuslog.core.model.Goal
import com.focuslog.core.model.Session
import com.focuslog.core.model.Versioned
import com.focuslog.core.store.OutboxEntity as CoreOutboxEntity
import com.focuslog.core.store.OutboxOp
import org.json.JSONObject

/** Room entity <-> core model mapping, shared by the store and reactive queries. */

internal fun GoalEntity.toModel() = Goal(
    goalId, title, color, weeklyTargetMinutes, sortOrder, status, createdAt, updatedAt, deleted, deviceId,
)

internal fun Goal.toEntity() = GoalEntity(
    goalId, title, color, weeklyTargetMinutes, sortOrder, status, createdAt, updatedAt, deleted, deviceId,
)

internal fun SessionEntity.toModel() = Session(
    logId, goalId, startUtc, endUtc, durationSeconds, localDate, tz, note, source, updatedAt, deleted, deviceId,
)

internal fun Session.toEntity() = SessionEntity(
    logId, goalId, startUtc, endUtc, durationSeconds, localDate, tz, note, source, updatedAt, deleted, deviceId,
)

internal fun OutboxEntity.toModel(): OutboxOp = OutboxOp(
    opId = opId,
    entity = CoreOutboxEntity.valueOf(entity),
    entityId = entityId,
    payload = decodePayload(entity, payloadJson),
    createdAt = createdAt,
    attempts = attempts,
    lastError = lastError,
    leasedUntil = leasedUntil,
)

internal fun OutboxOp.toEntity(): OutboxEntity = OutboxEntity(
    opId = opId ?: 0,
    entity = entity.name,
    entityId = entityId,
    payloadJson = encodePayload(payload),
    createdAt = createdAt,
    attempts = attempts,
    lastError = lastError,
    leasedUntil = leasedUntil,
)

// The payload is the full record to append. We keep it as JSON rather than a
// serialised row so the sync engine can re-serialise it through the one canonical
// row codec in :core (guarding against read/write column drift).

private fun encodePayload(payload: Versioned): String = when (payload) {
    is Goal -> JSONObject().apply {
        put("goalId", payload.goalId)
        put("title", payload.title)
        put("color", payload.color)
        put("weeklyTargetMinutes", payload.weeklyTargetMinutes)
        put("sortOrder", payload.sortOrder)
        put("status", payload.status)
        put("createdAt", payload.createdAt)
        put("updatedAt", payload.updatedAt)
        put("deleted", payload.deleted)
        put("deviceId", payload.deviceId)
    }.toString()

    is Session -> JSONObject().apply {
        put("logId", payload.logId)
        put("goalId", payload.goalId)
        put("startUtc", payload.startUtc)
        put("endUtc", payload.endUtc)
        put("durationSeconds", payload.durationSeconds)
        put("localDate", payload.localDate)
        put("tz", payload.tz)
        put("note", payload.note)
        put("source", payload.source)
        put("updatedAt", payload.updatedAt)
        put("deleted", payload.deleted)
        put("deviceId", payload.deviceId)
    }.toString()

    else -> error("Unknown payload type: ${payload::class}")
}

private fun decodePayload(entity: String, json: String): Versioned {
    val o = JSONObject(json)
    return when (CoreOutboxEntity.valueOf(entity)) {
        CoreOutboxEntity.GOAL -> Goal(
            goalId = o.getString("goalId"),
            title = o.getString("title"),
            color = o.getString("color"),
            weeklyTargetMinutes = o.getInt("weeklyTargetMinutes"),
            sortOrder = o.getInt("sortOrder"),
            status = o.getString("status"),
            createdAt = o.getString("createdAt"),
            updatedAt = o.getString("updatedAt"),
            deleted = o.getBoolean("deleted"),
            deviceId = o.getString("deviceId"),
        )

        CoreOutboxEntity.SESSION -> Session(
            logId = o.getString("logId"),
            goalId = o.getString("goalId"),
            startUtc = o.getString("startUtc"),
            endUtc = o.getString("endUtc"),
            durationSeconds = o.getInt("durationSeconds"),
            localDate = o.getString("localDate"),
            tz = o.getString("tz"),
            note = o.getString("note"),
            source = o.getString("source"),
            updatedAt = o.getString("updatedAt"),
            deleted = o.getBoolean("deleted"),
            deviceId = o.getString("deviceId"),
        )
    }
}
