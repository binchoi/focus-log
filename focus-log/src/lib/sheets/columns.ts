/**
 * Column layout for the focus-log spreadsheet.
 *
 * Every consumer — the CSV template, the A1 ranges used against the Sheets
 * API, the row serialiser and the row parser — is derived from these arrays.
 * That is deliberate: the old code hardcoded "logs!A:C" for writes and
 * "logs!A:D" for reads, so column D (duration) was read but never written
 * (C13). Deriving everything from one list makes that class of drift
 * impossible.
 */

/** A cell as it can arrive from the Sheets API with UNFORMATTED_VALUE. */
export type Cell = string | number | boolean | null | undefined;
export type Row = Cell[];

export type ColumnType = "string" | "number" | "boolean";

export interface ColumnDef<K extends string = string> {
  readonly key: K;
  readonly type: ColumnType;
  /** Documentation for SETUP.md; not used at runtime. */
  readonly note?: string;
}

export const SCHEMA_VERSION = 1;

export const GOAL_COLUMNS = [
  { key: "goal_id", type: "string", note: "UUIDv4. Stable forever, never reused." },
  { key: "title", type: "string" },
  { key: "color", type: "string", note: "Hex colour used by the UI." },
  { key: "weekly_target_minutes", type: "number", note: "0 means no target." },
  { key: "sort_order", type: "number" },
  { key: "status", type: "string", note: "active | archived" },
  { key: "created_at", type: "string", note: "ISO-8601 UTC" },
  { key: "updated_at", type: "string", note: "ISO-8601 UTC. The last-write-wins key." },
  { key: "deleted", type: "boolean", note: "Tombstone. TRUE hides the row." },
  { key: "device_id", type: "string", note: "Tie-breaker for identical updated_at." },
] as const satisfies readonly ColumnDef[];

export const SESSION_COLUMNS = [
  { key: "log_id", type: "string", note: "UUIDv4 minted before the write, so retries are idempotent." },
  { key: "goal_id", type: "string" },
  { key: "start_utc", type: "string", note: "ISO-8601 UTC" },
  { key: "end_utc", type: "string", note: "ISO-8601 UTC" },
  { key: "duration_seconds", type: "number", note: "Computed by the app, not a sheet formula." },
  { key: "local_date", type: "string", note: "YYYY-MM-DD in the timezone at log time." },
  { key: "tz", type: "string", note: "IANA zone, e.g. Asia/Singapore." },
  { key: "note", type: "string" },
  { key: "source", type: "string", note: "timer | manual | import" },
  { key: "updated_at", type: "string", note: "ISO-8601 UTC. The last-write-wins key." },
  { key: "deleted", type: "boolean", note: "Tombstone." },
  { key: "device_id", type: "string", note: "Tie-breaker for identical updated_at." },
] as const satisfies readonly ColumnDef[];

export const META_COLUMNS = [
  { key: "key", type: "string" },
  { key: "value", type: "string" },
] as const satisfies readonly ColumnDef[];

export const TAB_NAMES = {
  goals: "goals",
  sessions: "sessions",
  meta: "meta",
} as const;

export type TabName = (typeof TAB_NAMES)[keyof typeof TAB_NAMES];

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnLetter(index: number): string {
  if (index < 0) throw new RangeError(`Column index must be >= 0, got ${index}`);
  let n = index;
  let letters = "";
  for (;;) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    if (n < 26) return letters;
    n = Math.floor(n / 26) - 1;
  }
}

/** Whole-column A1 range covering exactly the defined columns, e.g. `sessions!A:L`. */
export function fullRange(tab: TabName, columns: readonly ColumnDef[]): string {
  return `${tab}!A:${columnLetter(columns.length - 1)}`;
}

export function headerRow(columns: readonly ColumnDef[]): string[] {
  return columns.map((c) => c.key);
}

export const RANGES = {
  goals: fullRange(TAB_NAMES.goals, GOAL_COLUMNS),
  sessions: fullRange(TAB_NAMES.sessions, SESSION_COLUMNS),
  meta: fullRange(TAB_NAMES.meta, META_COLUMNS),
} as const;
