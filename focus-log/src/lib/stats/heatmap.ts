/**
 * Heatmap layout.
 *
 * The old ContributionGrid positioned cells by array index — `x = ⌊i/7⌋`,
 * `y = i % 7` — so row 0 was whatever weekday the quarter happened to start on
 * (verified: Tuesday for Q3 2025, Wednesday for Q4 2025, Thursday for Q1 2026).
 * Rows therefore weren't weekdays and columns weren't calendar weeks, and with no
 * axis labels a cell was unidentifiable without hovering.
 *
 * It also counted *sessions per day*, so a four-hour block and a four-minute one
 * looked identical.
 *
 * This module computes a real calendar grid: rows are fixed weekdays, columns are
 * ISO weeks, and intensity is scaled by minutes.
 */

export interface HeatmapCell {
  date: string;
  /** 0 = Monday … 6 = Sunday. Fixed, so a row is always the same weekday. */
  weekday: number;
  /** Column index; each column is one calendar week. */
  week: number;
  seconds: number;
  /** 0–4, for colour banding. */
  level: number;
  isFuture: boolean;
}

export interface HeatmapLayout {
  cells: HeatmapCell[];
  weeks: number;
  /** Column index -> month label, emitted only when the month changes. */
  monthLabels: { week: number; label: string }[];
  maxSeconds: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Days are handled as UTC-midnight instants so no timezone shifts creep in. */
function dayUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
function isoWeekday(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

export function addDays(date: string, days: number): string {
  const next = dayUtc(date);
  next.setUTCDate(next.getUTCDate() + days);
  return toDateString(next);
}

/**
 * Thresholds derived from the data rather than fixed, so the scale stays
 * meaningful whether the user does 20-minute or 3-hour sessions.
 */
export function levelFor(seconds: number, maxSeconds: number): number {
  if (seconds <= 0) return 0;
  if (maxSeconds <= 0) return 0;
  const ratio = seconds / maxSeconds;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

export interface BuildHeatmapOptions {
  /** Inclusive first date, `YYYY-MM-DD`. Snapped back to the Monday of its week. */
  from: string;
  /** Inclusive last date. */
  to: string;
  /** Seconds focused per local date. */
  secondsByDate: Map<string, number>;
  /** "Today" in the user's zone, so future cells can be dimmed. */
  today: string;
}

export function buildHeatmap(options: BuildHeatmapOptions): HeatmapLayout {
  const { secondsByDate, today } = options;

  // Snap the start back to Monday so every column is a whole calendar week —
  // this is what makes rows line up with weekdays.
  const firstDay = dayUtc(options.from);
  const start = addDays(options.from, -isoWeekday(firstDay));

  const maxSeconds = Math.max(0, ...[...secondsByDate.values()]);

  const cells: HeatmapCell[] = [];
  const monthLabels: { week: number; label: string }[] = [];
  let seenMonth = "";

  let cursor = start;
  let week = 0;
  // Guard bounds the loop even if `to` precedes `from`.
  for (let guard = 0; guard < 4000 && cursor <= options.to; guard += 1) {
    const date = dayUtc(cursor);
    const weekday = isoWeekday(date);
    const seconds = secondsByDate.get(cursor) ?? 0;

    cells.push({
      date: cursor,
      weekday,
      week,
      seconds,
      level: levelFor(seconds, maxSeconds),
      isFuture: cursor > today,
    });

    // Label a column with the month its Monday falls in, once per month — but
    // only when there is room. Two months can start one column apart at the
    // snapped-back start of the range, which renders as "MarApr".
    if (weekday === 0) {
      const month = cursor.slice(0, 7);
      const lastLabel = monthLabels[monthLabels.length - 1];
      const roomForLabel = lastLabel === undefined || week - lastLabel.week >= 3;
      if (month !== seenMonth && roomForLabel) {
        seenMonth = month;
        monthLabels.push({ week, label: MONTHS[Number(cursor.slice(5, 7)) - 1] ?? "" });
      } else if (month !== seenMonth) {
        // Still record that we have entered the month, so the next one labels.
        seenMonth = month;
      }
    }

    if (weekday === 6) week += 1;
    cursor = addDays(cursor, 1);
  }

  return {
    cells,
    weeks: cells.length === 0 ? 0 : (cells[cells.length - 1]!.week ?? 0) + 1,
    monthLabels,
    maxSeconds,
  };
}

/**
 * Monday-based start of the week containing `instant`, as a local date.
 * Monday rather than Sunday because a "working week" is the useful unit here.
 */
export function startOfWeek(localToday: string): string {
  const weekday = new Date(`${localToday}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  return addDays(localToday, -((weekday + 6) % 7));
}

/** Consecutive days ending today (or yesterday) with any focus logged. */
export function currentStreak(secondsByDate: Map<string, number>, today: string): number {
  let streak = 0;
  let cursor = today;
  // Allow the streak to survive a today that hasn't been logged yet.
  if ((secondsByDate.get(cursor) ?? 0) <= 0) cursor = addDays(cursor, -1);
  for (let guard = 0; guard < 4000; guard += 1) {
    if ((secondsByDate.get(cursor) ?? 0) <= 0) break;
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}
