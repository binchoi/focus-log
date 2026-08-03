package com.focuslog.core.sheets

/**
 * Cell-level coercion between Sheets values and Kotlin values — a port of
 * `sheets/cells.ts`. Three past bugs live here:
 *
 *  - FORMATTED_VALUE returned 1234 as "1,234"; naive parsing yielded 1, so goal
 *    totals collapsed past 1,000 minutes. [toNumber] strips grouping separators
 *    so a hand-typed cell cannot reintroduce it.
 *  - A non-numeric cell must yield null, never a silent 0 that looks like data.
 *  - The Sheets API omits trailing empty cells, so a row can be shorter than the
 *    column list; [cellAt] treats short rows as empty.
 */

/** Short rows are normal: Sheets truncates trailing blanks. */
fun cellAt(row: Row, index: Int): Cell = if (index < row.size) row[index] else null

fun isBlank(cell: Cell): Boolean =
    cell == null || (cell is String && cell.trim().isEmpty())

fun toStringCell(cell: Cell): String = when {
    isBlank(cell) -> ""
    cell is String -> cell.trim()
    cell is Boolean -> if (cell) "TRUE" else "FALSE"
    else -> cell.toString()
}

private val NUMERIC = Regex("^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?$")

/**
 * Numeric coercion that refuses to guess. Returns null rather than NaN or 0 so
 * callers cannot silently treat a malformed cell as a real zero.
 */
fun toNumber(cell: Cell): Double? {
    if (isBlank(cell)) return null
    if (cell is Number) {
        val d = cell.toDouble()
        return if (d.isFinite()) d else null
    }
    if (cell is Boolean) return if (cell) 1.0 else 0.0

    val cleaned = cell.toString().trim().replace(",", "")
    if (!NUMERIC.matches(cleaned)) return null
    val parsed = cleaned.toDoubleOrNull() ?: return null
    return if (parsed.isFinite()) parsed else null
}

/**
 * Boolean coercion accepting every shape a tombstone can take: a real boolean,
 * a number, or a human-typed TRUE / "true" / 1 (including from a CSV import).
 */
fun toBoolean(cell: Cell): Boolean {
    if (isBlank(cell)) return false
    if (cell is Boolean) return cell
    if (cell is Number) return cell.toDouble() != 0.0
    val raw = cell.toString().trim().lowercase()
    return raw == "true" || raw == "yes" || raw == "1"
}

/**
 * Value to send to the Sheets API. Paired with valueInputOption=RAW so nothing
 * is re-parsed: ISO timestamps stay text, a leading-zero id stays text, numbers
 * stay numbers.
 */
fun toSheetValue(value: Cell): Cell = value ?: ""
