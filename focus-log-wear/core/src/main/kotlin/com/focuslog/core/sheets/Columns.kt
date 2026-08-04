package com.focuslog.core.sheets

/**
 * Column layout for the focus-log spreadsheet — a port of `sheets/columns.ts`.
 *
 * Every consumer (A1 ranges, row serialiser, row parser) derives from these
 * lists. Deriving everything from one source makes read/write column drift
 * impossible — the class of bug that once had column D read but never written.
 *
 * Column order is load-bearing: the app addresses cells by position.
 */

/** A cell as it can arrive from the Sheets API with UNFORMATTED_VALUE. */
typealias Cell = Any?
typealias Row = List<Cell>

enum class ColumnType { STRING, NUMBER, BOOLEAN }

data class ColumnDef(val key: String, val type: ColumnType)

// v2 adds the optional `active` tab (cross-device running timer). Backward
// compatible: a v2 client still reads and writes a v1 sheet, it just leaves the
// cross-device timer off until the `active` tab is added.
const val SCHEMA_VERSION = 2

val GOAL_COLUMNS: List<ColumnDef> = listOf(
    ColumnDef("goal_id", ColumnType.STRING),
    ColumnDef("title", ColumnType.STRING),
    ColumnDef("color", ColumnType.STRING),
    ColumnDef("weekly_target_minutes", ColumnType.NUMBER),
    ColumnDef("sort_order", ColumnType.NUMBER),
    ColumnDef("status", ColumnType.STRING),
    ColumnDef("created_at", ColumnType.STRING),
    ColumnDef("updated_at", ColumnType.STRING),
    ColumnDef("deleted", ColumnType.BOOLEAN),
    ColumnDef("device_id", ColumnType.STRING),
)

val SESSION_COLUMNS: List<ColumnDef> = listOf(
    ColumnDef("log_id", ColumnType.STRING),
    ColumnDef("goal_id", ColumnType.STRING),
    ColumnDef("start_utc", ColumnType.STRING),
    ColumnDef("end_utc", ColumnType.STRING),
    ColumnDef("duration_seconds", ColumnType.NUMBER),
    ColumnDef("local_date", ColumnType.STRING),
    ColumnDef("tz", ColumnType.STRING),
    ColumnDef("note", ColumnType.STRING),
    ColumnDef("source", ColumnType.STRING),
    ColumnDef("updated_at", ColumnType.STRING),
    ColumnDef("deleted", ColumnType.BOOLEAN),
    ColumnDef("device_id", ColumnType.STRING),
)

val META_COLUMNS: List<ColumnDef> = listOf(
    ColumnDef("key", ColumnType.STRING),
    ColumnDef("value", ColumnType.STRING),
)

// The shared running timer (v2+): one versioned row per in-progress session,
// keyed by `log_id`. The id is minted at start and reused at finalise, so two
// devices ending the same timer append rows with the same id that LWW collapses.
// `deleted=TRUE` tombstones a stopped/discarded timer; `segments` carries the
// pause structure so another device shows correct elapsed and can stop it.
val ACTIVE_COLUMNS: List<ColumnDef> = listOf(
    ColumnDef("log_id", ColumnType.STRING),
    ColumnDef("goal_id", ColumnType.STRING),
    ColumnDef("segments", ColumnType.STRING),
    ColumnDef("note", ColumnType.STRING),
    ColumnDef("updated_at", ColumnType.STRING),
    ColumnDef("deleted", ColumnType.BOOLEAN),
    ColumnDef("device_id", ColumnType.STRING),
)

object TabNames {
    const val GOALS = "goals"
    const val SESSIONS = "sessions"
    const val META = "meta"
    const val ACTIVE = "active"
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
fun columnLetter(index: Int): String {
    require(index >= 0) { "Column index must be >= 0, got $index" }
    var n = index
    var letters = ""
    while (true) {
        letters = ('A' + (n % 26)) + letters
        if (n < 26) return letters
        n = n / 26 - 1
    }
}

/** Whole-column A1 range covering exactly the defined columns, e.g. `sessions!A:L`. */
fun fullRange(tab: String, columns: List<ColumnDef>): String =
    "$tab!A:${columnLetter(columns.size - 1)}"

fun headerRow(columns: List<ColumnDef>): List<String> = columns.map { it.key }

object Ranges {
    val goals: String = fullRange(TabNames.GOALS, GOAL_COLUMNS)
    val sessions: String = fullRange(TabNames.SESSIONS, SESSION_COLUMNS)
    val meta: String = fullRange(TabNames.META, META_COLUMNS)
    val active: String = fullRange(TabNames.ACTIVE, ACTIVE_COLUMNS)
}
