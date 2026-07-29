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
  GOAL_COLUMNS,
  META_COLUMNS,
  SESSION_COLUMNS,
  type Cell,
  type ColumnDef,
  type Row,
} from "./columns";
import { cellAt, isBlank, toBoolean, toNumber, toSheetValue, toStringCell } from "./cells";

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
    duration_seconds: z.number().int().min(0).max(24 * 60 * 60),
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
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: z.ZodError } },
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
