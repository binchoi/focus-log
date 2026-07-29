/**
 * Time handling for focus-log.
 *
 * The old app wrote local-time strings like "01/15/2025 14:30:00" with no
 * offset and read them back with `new Date(...)`, which is both
 * implementation-defined and timezone-lossy: once you changed timezone, past
 * sessions silently shifted (EPCC_EXPLORE C10).
 *
 * This module keeps two things that cannot be derived from each other after
 * the fact:
 *   - an absolute instant (ISO-8601 UTC), for correct arithmetic
 *   - the calendar date *as the user experienced it*, plus the IANA zone,
 *     for correct "what did I do on Tuesday" grouping
 */

/** `YYYY-MM-DD`, the calendar date as experienced in some timezone. */
export type LocalDate = string;

/** ISO-8601 instant in UTC, e.g. `2026-07-29T06:30:00.000Z`. */
export type IsoUtc = string;

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoUtc(value: unknown): value is IsoUtc {
  return typeof value === "string" && ISO_UTC_RE.test(value) && !Number.isNaN(Date.parse(value));
}

export function isLocalDate(value: unknown): value is LocalDate {
  return typeof value === "string" && LOCAL_DATE_RE.test(value);
}

/** Serialise an instant for storage. Always UTC, always millisecond-precise. */
export function toIsoUtc(date: Date): IsoUtc {
  if (Number.isNaN(date.getTime())) throw new RangeError("Cannot serialise an Invalid Date");
  return date.toISOString();
}

/** The user's current IANA timezone, e.g. `Asia/Singapore`. */
export function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The calendar date of `instant` as seen in `timeZone`.
 *
 * Uses formatToParts rather than string slicing so it is locale-independent —
 * `toLocaleDateString` output varies by the host's default locale, which is
 * exactly the class of bug this module exists to avoid.
 */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  let year = "";
  let month = "";
  let day = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  if (!year || !month || !day) {
    throw new RangeError(`Could not derive a local date for timeZone "${timeZone}"`);
  }
  return `${year}-${month}-${day}`;
}

/**
 * Whole seconds between two instants.
 *
 * Deliberately *not* rounded down to minutes: the old app did
 * `Math.floor(seconds / 60)` and threw away up to 59s on every single session,
 * systematically biased downward (C6), and turned sub-minute sessions into
 * zero-duration rows (C7).
 */
export function durationSeconds(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (Number.isNaN(ms)) throw new RangeError("Invalid Date in duration calculation");
  return Math.round(ms / 1000);
}

/** Format seconds as `H:MM:SS`, or `M:SS` under an hour. */
export function formatDuration(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "-" : "";
  const s = Math.abs(Math.trunc(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  // The old UI rendered MM:SS from Math.floor(t/60), so a 2h05m session showed
  // as "122:05" (C15). Roll into hours instead.
  return hours > 0 ? `${sign}${hours}:${mm}:${ss}` : `${sign}${minutes}:${ss}`;
}

/** Human-friendly total, e.g. `2h 5m`. Used for goal and day totals. */
export function formatTotal(totalSeconds: number): string {
  const s = Math.max(0, Math.trunc(totalSeconds));
  if (s === 0) return "0m";
  // Anything under a minute is real work but rounds to zero; say so explicitly
  // rather than reporting "0m" or rounding 30s up to "1m".
  if (s < 60) return "<1m";
  // Round to whole minutes first, then split. Splitting before rounding lets
  // 3570s render as "1h 60m".
  const totalMinutes = Math.round(s / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Inclusive list of local dates spanned by a range, in `timeZone`.
 * Used by the heatmap so a session that crosses midnight is attributed to the
 * day it started, while range queries still find it.
 */
export function localDatesBetween(start: Date, end: Date, timeZone: string): LocalDate[] {
  const dates: LocalDate[] = [];
  const cursor = new Date(start.getTime());
  const last = localDateOf(end, timeZone);
  // Step in 12h increments so DST shifts (23h/25h days) cannot skip a date.
  for (let guard = 0; guard < 4000; guard += 1) {
    const current = localDateOf(cursor, timeZone);
    if (dates[dates.length - 1] !== current) dates.push(current);
    if (current >= last) break;
    cursor.setTime(cursor.getTime() + 12 * 60 * 60 * 1000);
  }
  return dates;
}
