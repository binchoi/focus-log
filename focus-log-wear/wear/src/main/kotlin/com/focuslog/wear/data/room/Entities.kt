package com.focuslog.wear.data.room

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Room mirror of the sheet schema. Room is the watch's source of truth; the
 * spreadsheet is a sync target. Column names match the core model so mapping is
 * mechanical.
 */

@Entity(tableName = "goals")
data class GoalEntity(
    @PrimaryKey val goalId: String,
    val title: String,
    val color: String,
    val weeklyTargetMinutes: Int,
    val sortOrder: Int,
    val status: String,
    val createdAt: String,
    val updatedAt: String,
    val deleted: Boolean,
    val deviceId: String,
)

@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey val logId: String,
    val goalId: String,
    val startUtc: String,
    val endUtc: String,
    val durationSeconds: Int,
    val localDate: String,
    val tz: String,
    val note: String,
    val source: String,
    val updatedAt: String,
    val deleted: Boolean,
    val deviceId: String,
)

@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey(autoGenerate = true) val opId: Long = 0,
    val entity: String, // "GOAL" | "SESSION"
    val entityId: String,
    val payloadJson: String,
    val createdAt: String,
    val attempts: Int,
    val lastError: String?,
    val leasedUntil: Long?,
)

/** At most one row, id "current". Persists the running timer across process death. */
@Entity(tableName = "active_session")
data class ActiveSessionEntity(
    @PrimaryKey val id: String = "current",
    val goalId: String,
    /** JSON array of {start, end} segments; end null while running. */
    val segmentsJson: String,
    val startedAt: Long,
    val note: String,
)

@Entity(tableName = "sync_meta")
data class SyncMetaEntity(
    @PrimaryKey val key: String,
    val value: String,
)
