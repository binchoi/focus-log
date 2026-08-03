package com.focuslog.core.model

/**
 * Domain entities, mirrored from the web app's `sheets/schema.ts`.
 *
 * Kotlin properties are camelCase; the load-bearing snake_case names live in
 * [com.focuslog.core.sheets.Columns] and are used only when (de)serialising rows.
 */

/** Anything the sheet stores as a versioned, tombstone-able record. */
interface Versioned {
    /** ISO-8601 UTC. The last-write-wins key. Compared as a parsed instant. */
    val updatedAt: String

    /** Tombstone. Kept through a merge so a delete can propagate. */
    val deleted: Boolean

    /** Tie-breaker when two devices write the same instant. */
    val deviceId: String
}

data class Goal(
    val goalId: String,
    val title: String,
    val color: String = "#4caf50",
    val weeklyTargetMinutes: Int = 0,
    val sortOrder: Int = 0,
    val status: String = "active",
    val createdAt: String,
    override val updatedAt: String,
    override val deleted: Boolean = false,
    override val deviceId: String = "",
) : Versioned

data class Session(
    val logId: String,
    val goalId: String,
    val startUtc: String,
    val endUtc: String,
    val durationSeconds: Int,
    val localDate: String,
    val tz: String = "UTC",
    val note: String = "",
    val source: String = "timer",
    override val updatedAt: String,
    override val deleted: Boolean = false,
    override val deviceId: String = "",
) : Versioned
