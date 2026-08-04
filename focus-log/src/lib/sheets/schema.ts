/**
 * Domain entities and their Sheets row codecs.
 *
 * Rows are validated on the way in with Zod. A malformed row is *skipped and
 * reported*, never rendered as garbage — the old code would happily build a
 * record with `NaN` durations and an "Unknown Goal" title and show it as real
 * data.
 */

import { z } from "zod";
import {
  ACTIVE_COLUMNS,
  GOAL_COLUMNS,
  META_COLUMNS,
  SESSION_COLUMNS,
  type Cell,
  type ColumnDef,
  type Row,
} from "./columns";
import { cellAt, isBlank, toBoolean, toNumber, toSheetValue, toStringCell } from "./cells";
import type { Segment } from "../timer/engine";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const isoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, "must be an ISO-8601 UTC instant")
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be a real date");

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

// Not z.uuid(): ids created by older clients or by hand should still load. We
// only require something non-empty and free of the characters that would break
// an A1 range or a CSV round-trip.
const entityId = z
  .string()
  .min(1, "id must not be empty")
  .max(64)
  .regex(/^[A-Za-z0-9_:-]+$/, "id may only contain letters, digits, -, _ and :");

export const GoalSchema = z.object({
  goal_id: entityId,
  title: z.string().min(1).max(200),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex colour")
    .default("#4caf50"),
  weekly_target_minutes: z.number().int().min(0).max(10080).default(0),
  sort_order: z.number().int().default(0),
  status: z.enum(["active", "archived"]).default("active"),
  created_at: isoUtc,
  updated_at: isoUtc,
  deleted: z.boolean().default(false),
  device_id: z.string().max(64).default(""),
});

export const SessionSchema = z
  .object({
    log_id: entityId,
    goal_id: entityId,
    start_utc: isoUtc,
    end_utc: isoUtc,
    duration_seconds: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60),
    local_date: localDate,
    tz: z.string().min(1).max(64).default("UTC"),
    note: z.string().max(2000).default(""),
    source: z.enum(["timer", "manual", "import"]).default("timer"),
    updated_at: isoUtc,
    deleted: z.boolean().default(false),
    device_id: z.string().max(64).default(""),
  })
  .refine((s) => Date.parse(s.end_utc) >= Date.parse(s.start_utc), {
    message: "end_utc must not precede start_utc",
    path: ["end_utc"],
  });

export type Goal = z.infer<typeof GoalSchema>;
export type Session = z.infer<typeof SessionSchema>;

export type MetaEntry = { key: string; value: string };

// ---------------------------------------------------------------------------
// Active timer (the shared running session, v2+)
// ---------------------------------------------------------------------------

/**
 * The scalar fields of an active-timer row. `segments` is handled separately
 * because it packs a whole interval list into one cell (see the segments codec).
 */
const ActiveTimerRowSchema = z.object({
  log_id: entityId,
  goal_id: entityId,
  note: z.string().max(2000).default(""),
  updated_at: isoUtc,
  deleted: z.boolean().default(false),
  device_id: z.string().max(64).default(""),
});

export interface ActiveTimer {
  log_id: string;
  goal_id: string;
  /** Focus intervals; the trailing segment is open (`end === null`) while running. */
  segments: Segment[];
  note: string;
  updated_at: string;
  deleted: boolean;
  device_id: string;
}

/**
 * Serialise focus intervals into a single cell as `startMs,endMs;startMs,` — an
 * open (running) segment leaves its end blank. Deliberately not JSON: the Kotlin
 * core has no JSON dependency, and this grammar parses identically in both with
 * a `split`. Conformance vectors pin the two encoders together.
 */
export function encodeSegments(segments: Segment[]): string {
  return segments.map((s) => `${s.start},${s.end ?? ""}`).join(";");
}

// Only a plain optional-signed integer, matching Kotlin's `String.toLong()`.
// `Number()` alone would accept "1e3" (→1000) and "0x10", which Kotlin rejects —
// so the two cores would disagree on whether a hand-edited `segments` cell is
// valid. Pinned by /conformance/segments-codec.json.
const SEGMENT_INT = /^[+-]?\d+$/;

function segmentInt(text: string, pair: string): number {
  if (!SEGMENT_INT.test(text.trim())) {
    throw new Error(`segment "${pair}" is not epoch-millisecond integers`);
  }
  return Number(text);
}

/** Inverse of {@link encodeSegments}. Throws on a malformed value so the row is reported, not shown. */
export function decodeSegments(raw: string): Segment[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return trimmed.split(";").map((pair) => {
    const parts = pair.split(",");
    if (parts.length !== 2) {
      throw new Error(`segment "${pair}" must be a single start,end pair`);
    }
    const start = segmentInt(parts[0]!, pair);
    const endText = parts[1]!.trim();
    const end = endText === "" ? null : segmentInt(parts[1]!, pair);
    if (end !== null && end < start) {
      throw new Error(`segment "${pair}" ends before it starts`);
    }
    return { start, end };
  });
}

export function parseActiveRows(values: Row[] | undefined | null): ParseResult<ActiveTimer> {
  const records: ActiveTimer[] = [];
  const failures: ParseFailure[] = [];

  stripHeader(values).forEach((row, index) => {
    if (row.every((cell) => isBlank(cell))) return;

    const fields = rowToRaw(row, ACTIVE_COLUMNS);
    const problems: string[] = [];

    const scalars = ActiveTimerRowSchema.safeParse(fields);
    if (!scalars.success) {
      problems.push(
        ...scalars.error.issues.map((i) =>
          i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
        ),
      );
    }

    let segments: Segment[] = [];
    try {
      segments = decodeSegments(typeof fields.segments === "string" ? fields.segments : "");
      if (segments.length === 0)
        problems.push("segments: an active timer needs at least one segment");
    } catch (error) {
      problems.push(`segments: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!scalars.success || problems.length > 0) {
      failures.push({ sheetRow: index + 2, problems, raw: row });
      return;
    }
    records.push({ ...scalars.data, segments });
  });

  return { records, failures };
}

export function activeToRow(active: ActiveTimer): Cell[] {
  return entityToRow(
    {
      log_id: active.log_id,
      goal_id: active.goal_id,
      segments: encodeSegments(active.segments),
      note: active.note,
      updated_at: active.updated_at,
      deleted: active.deleted,
      device_id: active.device_id,
    },
    ACTIVE_COLUMNS,
  );
}

// ---------------------------------------------------------------------------
// Row codec
// ---------------------------------------------------------------------------

/** Raw field bag read off a row, before Zod validation. */
type RawRecord = Record<string, unknown>;

function rowToRaw(row: Row, columns: readonly ColumnDef[]): RawRecord {
  const out: RawRecord = {};
  columns.forEach((column, index) => {
    const cell = cellAt(row, index);
    switch (column.type) {
      case "number": {
        const n = toNumber(cell);
        // Leave the key absent when blank so Zod applies the column default
        // instead of us inventing a 0 that looks like real data.
        if (n !== undefined) out[column.key] = n;
        break;
      }
      case "boolean":
        out[column.key] = toBoolean(cell);
        break;
      default: {
        if (!isBlank(cell)) out[column.key] = toStringCell(cell);
        break;
      }
    }
  });
  return out;
}

function entityToRow(entity: RawRecord, columns: readonly ColumnDef[]): Cell[] {
  return columns.map((column) =>
    toSheetValue(entity[column.key] as string | number | boolean | undefined),
  );
}

export interface ParseFailure {
  /** 1-based row number in the sheet, including the header. */
  sheetRow: number;
  problems: string[];
  raw: Row;
}

export interface ParseResult<T> {
  records: T[];
  failures: ParseFailure[];
}

function parseRows<T>(
  rows: Row[],
  columns: readonly ColumnDef[],
  schema: {
    safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: z.ZodError };
  },
): ParseResult<T> {
  const records: T[] = [];
  const failures: ParseFailure[] = [];

  rows.forEach((row, index) => {
    // Wholly blank rows are padding, not corruption — skip silently.
    if (row.every((cell) => isBlank(cell))) return;

    const parsed = schema.safeParse(rowToRaw(row, columns));
    if (parsed.success) {
      records.push(parsed.data);
    } else {
      failures.push({
        sheetRow: index + 2, // +1 for the header, +1 for 1-based numbering
        problems: parsed.error.issues.map((i) =>
          i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
        ),
        raw: row,
      });
    }
  });

  return { records, failures };
}

/** Drops the header row. Tolerates a sheet whose values array is empty. */
export function stripHeader(values: Row[] | undefined | null): Row[] {
  if (!values || values.length === 0) return [];
  return values.slice(1);
}

export function parseGoalRows(values: Row[] | undefined | null): ParseResult<Goal> {
  return parseRows(stripHeader(values), GOAL_COLUMNS, GoalSchema);
}

export function parseSessionRows(values: Row[] | undefined | null): ParseResult<Session> {
  return parseRows(stripHeader(values), SESSION_COLUMNS, SessionSchema);
}

export function goalToRow(goal: Goal): Cell[] {
  return entityToRow(goal as unknown as RawRecord, GOAL_COLUMNS);
}

export function sessionToRow(session: Session): Cell[] {
  return entityToRow(session as unknown as RawRecord, SESSION_COLUMNS);
}

export function parseMetaRows(values: Row[] | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of stripHeader(values)) {
    const key = toStringCell(cellAt(row, 0));
    if (key) out[key] = toStringCell(cellAt(row, 1));
  }
  return out;
}

export function metaToRows(entries: Record<string, string>): Cell[][] {
  return Object.entries(entries).map(([key, value]) => entityToRow({ key, value }, META_COLUMNS));
}
