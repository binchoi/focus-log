/**
 * Cell-level coercion between Sheets values and JS values.
 *
 * Three exploration findings live here:
 *
 * C8 — the Sheets API defaults to valueRenderOption=FORMATTED_VALUE, so 1234
 *   can arrive as the string "1,234"; `parseInt("1,234")` is 1, so goal totals
 *   silently collapsed once they passed 1,000 minutes. We now always request
 *   UNFORMATTED_VALUE, but `toNumber` still strips grouping separators so a
 *   hand-typed cell cannot reintroduce the bug.
 *
 * C9 — `parseInt("health")` is NaN and `NaN === NaN` is false, so a
 *   non-numeric id made every chart render empty with no error. Coercion here
 *   returns `undefined` on failure so callers must handle it explicitly.
 *
 * C14 — the Sheets API omits trailing empty cells, so a row array can be
 *   shorter than the column list. `cellAt` treats short rows as empty rather
 *   than letting `undefined` leak into parsed records.
 */

import type { Cell, Row } from "./columns";

export function cellAt(row: Row, index: number): Cell {
  // Short rows are normal, not exceptional: Sheets truncates trailing blanks.
  return index < row.length ? row[index] : undefined;
}

export function isBlank(cell: Cell): boolean {
  return cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "");
}

export function toStringCell(cell: Cell): string {
  if (isBlank(cell)) return "";
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  return String(cell);
}

/**
 * Numeric coercion that refuses to guess.
 * Returns `undefined` rather than NaN or 0 so callers cannot silently treat a
 * malformed cell as a real zero.
 */
export function toNumber(cell: Cell): number | undefined {
  if (isBlank(cell)) return undefined;
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : undefined;
  if (typeof cell === "boolean") return cell ? 1 : 0;

  const raw = String(cell).trim();
  // Strip thousands separators and a trailing/leading currency-ish symbol, but
  // only when what remains is unambiguously numeric.
  const cleaned = raw.replace(/,/g, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Boolean coercion accepting every shape a tombstone can take.
 * We write real JSON booleans, but a human editing the sheet may type TRUE,
 * "true", or 1, and a CSV import yields strings.
 */
export function toBoolean(cell: Cell): boolean {
  if (isBlank(cell)) return false;
  if (typeof cell === "boolean") return cell;
  if (typeof cell === "number") return cell !== 0;
  const raw = String(cell).trim().toLowerCase();
  return raw === "true" || raw === "yes" || raw === "1";
}

/**
 * Value to send to the Sheets API. Paired with valueInputOption=RAW so nothing
 * is re-parsed on the way in: ISO timestamps stay text, ids stay text (a
 * leading-zero id is not turned into a number), and numbers stay numbers.
 */
export function toSheetValue(value: string | number | boolean | undefined | null): Cell {
  if (value === undefined || value === null) return "";
  return value;
}
