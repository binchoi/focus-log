package com.focuslog.core.sheets

import com.focuslog.core.model.ActiveTimer
import com.focuslog.core.model.Goal
import com.focuslog.core.model.Session
import com.focuslog.core.timer.Segment

/**
 * Row codec — a port of the serialise/parse half of `sheets/schema.ts`.
 *
 * A malformed row is *skipped and reported*, never rendered as garbage: the old
 * code would build a record with a NaN duration and an "Unknown Goal" title and
 * show it as real data. Serialisation orders fields to match the column lists in
 * [Columns]; a mismatch there is the one thing that corrupts the sheet, so both
 * directions read from the same source.
 */

data class ParseFailure(
    /** 1-based row number in the sheet, including the header. */
    val sheetRow: Int,
    val problems: List<String>,
    val raw: Row,
)

data class ParseResult<T>(val records: List<T>, val failures: List<ParseFailure>)

/** Drops the header row. Tolerates an empty values array. */
fun stripHeader(values: List<Row>?): List<Row> =
    if (values.isNullOrEmpty()) emptyList() else values.drop(1)

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

fun goalToRow(goal: Goal): List<Cell> = listOf(
    goal.goalId,
    goal.title,
    goal.color,
    goal.weeklyTargetMinutes,
    goal.sortOrder,
    goal.status,
    goal.createdAt,
    goal.updatedAt,
    goal.deleted,
    goal.deviceId,
).map { toSheetValue(it) }

fun sessionToRow(session: Session): List<Cell> = listOf(
    session.logId,
    session.goalId,
    session.startUtc,
    session.endUtc,
    session.durationSeconds,
    session.localDate,
    session.tz,
    session.note,
    session.source,
    session.updatedAt,
    session.deleted,
    session.deviceId,
).map { toSheetValue(it) }

fun metaToRows(entries: Map<String, String>): List<List<Cell>> =
    entries.map { (key, value) -> listOf<Cell>(toSheetValue(key), toSheetValue(value)) }

fun activeToRow(active: ActiveTimer): List<Cell> = listOf(
    active.logId,
    active.goalId,
    encodeSegments(active.segments),
    active.note,
    active.updatedAt,
    active.deleted,
    active.deviceId,
).map { toSheetValue(it) }

/**
 * Serialise focus intervals into one cell as `startMs,endMs;startMs,` — an open
 * (running) segment leaves its end blank. Not JSON, so it parses identically here
 * and in the web core with a `split`; the conformance vectors pin the two.
 */
fun encodeSegments(segments: List<Segment>): String =
    segments.joinToString(";") { "${it.start},${it.end ?: ""}" }

/** Inverse of [encodeSegments]. Throws on a malformed value so the row is reported, not shown. */
fun decodeSegments(raw: String): List<Segment> {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return emptyList()
    return trimmed.split(";").map { pair ->
        val parts = pair.split(",")
        require(parts.size == 2) { "segment \"$pair\" must be a single start,end pair" }
        val start = parts[0].trim().toLongOrNull()
            ?: throw IllegalArgumentException("segment \"$pair\" is not epoch-millisecond integers")
        val endText = parts[1].trim()
        val end = if (endText.isEmpty()) {
            null
        } else {
            endText.toLongOrNull()
                ?: throw IllegalArgumentException("segment \"$pair\" is not epoch-millisecond integers")
        }
        if (end != null && end < start) {
            throw IllegalArgumentException("segment \"$pair\" ends before it starts")
        }
        Segment(start, end)
    }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

private fun isoUtc(value: String): Boolean =
    Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$").matches(value)

private fun localDatePattern(value: String): Boolean =
    Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(value)

private fun entityId(value: String): Boolean =
    value.isNotEmpty() && value.length <= 64 && Regex("^[A-Za-z0-9_:-]+$").matches(value)

private fun <T> parseRows(
    rows: List<Row>,
    parseOne: (Row) -> Result<T>,
): ParseResult<T> {
    val records = ArrayList<T>()
    val failures = ArrayList<ParseFailure>()
    rows.forEachIndexed { index, row ->
        // Wholly blank rows are padding, not corruption — skip silently.
        if (row.all { isBlank(it) }) return@forEachIndexed
        parseOne(row).fold(
            onSuccess = { records.add(it) },
            onFailure = { error ->
                failures.add(
                    ParseFailure(
                        sheetRow = index + 2, // +1 header, +1 for 1-based numbering
                        problems = (error.message ?: "invalid row").split("; "),
                        raw = row,
                    ),
                )
            },
        )
    }
    return ParseResult(records, failures)
}

private class RowProblems {
    private val problems = ArrayList<String>()
    fun add(field: String, message: String) = problems.add("$field: $message")
    fun failIfAny() {
        if (problems.isNotEmpty()) throw IllegalArgumentException(problems.joinToString("; "))
    }
}

fun parseGoalRows(values: List<Row>?): ParseResult<Goal> = parseRows(stripHeader(values)) { row ->
    runCatching {
        val p = RowProblems()
        val goalId = toStringCell(cellAt(row, 0))
        if (!entityId(goalId)) p.add("goal_id", "invalid id")
        val title = toStringCell(cellAt(row, 1))
        if (title.isEmpty() || title.length > 200) p.add("title", "must be 1–200 chars")
        val color = toStringCell(cellAt(row, 2)).ifEmpty { "#4caf50" }
        if (!Regex("^#[0-9a-fA-F]{6}$").matches(color)) p.add("color", "must be a #rrggbb hex colour")
        val weekly = toNumber(cellAt(row, 3))?.toInt() ?: 0
        val sortOrder = toNumber(cellAt(row, 4))?.toInt() ?: 0
        val status = toStringCell(cellAt(row, 5)).ifEmpty { "active" }
        if (status != "active" && status != "archived") p.add("status", "must be active | archived")
        val createdAt = toStringCell(cellAt(row, 6))
        if (!isoUtc(createdAt)) p.add("created_at", "must be an ISO-8601 UTC instant")
        val updatedAt = toStringCell(cellAt(row, 7))
        if (!isoUtc(updatedAt)) p.add("updated_at", "must be an ISO-8601 UTC instant")
        p.failIfAny()
        Goal(
            goalId = goalId,
            title = title,
            color = color,
            weeklyTargetMinutes = weekly,
            sortOrder = sortOrder,
            status = status,
            createdAt = createdAt,
            updatedAt = updatedAt,
            deleted = toBoolean(cellAt(row, 8)),
            deviceId = toStringCell(cellAt(row, 9)),
        )
    }
}

fun parseSessionRows(values: List<Row>?): ParseResult<Session> = parseRows(stripHeader(values)) { row ->
    runCatching {
        val p = RowProblems()
        val logId = toStringCell(cellAt(row, 0))
        if (!entityId(logId)) p.add("log_id", "invalid id")
        val goalId = toStringCell(cellAt(row, 1))
        if (!entityId(goalId)) p.add("goal_id", "invalid id")
        val startUtc = toStringCell(cellAt(row, 2))
        if (!isoUtc(startUtc)) p.add("start_utc", "must be an ISO-8601 UTC instant")
        val endUtc = toStringCell(cellAt(row, 3))
        if (!isoUtc(endUtc)) p.add("end_utc", "must be an ISO-8601 UTC instant")
        val duration = toNumber(cellAt(row, 4))?.toInt()
        if (duration == null || duration < 0 || duration > 24 * 60 * 60) {
            p.add("duration_seconds", "must be 0–86400")
        }
        val localDate = toStringCell(cellAt(row, 5))
        if (!localDatePattern(localDate)) p.add("local_date", "must be YYYY-MM-DD")
        val tz = toStringCell(cellAt(row, 6)).ifEmpty { "UTC" }
        val note = toStringCell(cellAt(row, 7))
        val source = toStringCell(cellAt(row, 8)).ifEmpty { "timer" }
        if (source != "timer" && source != "manual" && source != "import") {
            p.add("source", "must be timer | manual | import")
        }
        val updatedAt = toStringCell(cellAt(row, 9))
        if (!isoUtc(updatedAt)) p.add("updated_at", "must be an ISO-8601 UTC instant")
        if (isoUtc(startUtc) && isoUtc(endUtc) &&
            java.time.Instant.parse(endUtc) < java.time.Instant.parse(startUtc)
        ) {
            p.add("end_utc", "must not precede start_utc")
        }
        p.failIfAny()
        Session(
            logId = logId,
            goalId = goalId,
            startUtc = startUtc,
            endUtc = endUtc,
            durationSeconds = duration!!,
            localDate = localDate,
            tz = tz,
            note = note,
            source = source,
            updatedAt = updatedAt,
            deleted = toBoolean(cellAt(row, 10)),
            deviceId = toStringCell(cellAt(row, 11)),
        )
    }
}

fun parseActiveRows(values: List<Row>?): ParseResult<ActiveTimer> = parseRows(stripHeader(values)) { row ->
    runCatching {
        val p = RowProblems()
        val logId = toStringCell(cellAt(row, 0))
        if (!entityId(logId)) p.add("log_id", "invalid id")
        val goalId = toStringCell(cellAt(row, 1))
        if (!entityId(goalId)) p.add("goal_id", "invalid id")
        var segments: List<Segment> = emptyList()
        try {
            segments = decodeSegments(toStringCell(cellAt(row, 2)))
            if (segments.isEmpty()) p.add("segments", "an active timer needs at least one segment")
        } catch (e: Exception) {
            p.add("segments", e.message ?: "malformed")
        }
        val note = toStringCell(cellAt(row, 3))
        val updatedAt = toStringCell(cellAt(row, 4))
        if (!isoUtc(updatedAt)) p.add("updated_at", "must be an ISO-8601 UTC instant")
        p.failIfAny()
        ActiveTimer(
            logId = logId,
            goalId = goalId,
            segments = segments,
            note = note,
            updatedAt = updatedAt,
            deleted = toBoolean(cellAt(row, 5)),
            deviceId = toStringCell(cellAt(row, 6)),
        )
    }
}

fun parseMetaRows(values: List<Row>?): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (row in stripHeader(values)) {
        val key = toStringCell(cellAt(row, 0))
        if (key.isNotEmpty()) out[key] = toStringCell(cellAt(row, 1))
    }
    return out
}
