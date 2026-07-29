"use client";

/**
 * Contribution heatmap.
 *
 * Layout comes from src/lib/stats/heatmap.ts, which produces a genuine calendar
 * grid: rows are fixed weekdays, columns are calendar weeks. The old d3 version
 * positioned cells by array index, so row 0 was whatever weekday the range began
 * on — Tuesday for Q3 2025, Wednesday for Q4 2025 — meaning rows weren't
 * weekdays and columns weren't weeks. It also counted *sessions* per day, so a
 * four-hour block and a four-minute one looked identical.
 *
 * Rendered as a single CSS grid so cells and month labels share one column
 * track. Two grids with independent tracks is exactly why the first version's
 * labels drifted out of alignment with the cells.
 */

import type { HeatmapLayout } from "@lib/stats/heatmap";
import { formatTotal } from "@lib/time";
import { cn } from "./ui";

const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
const GUTTER = 30;
const GAP = 3;
/** Below this the grid scrolls rather than squeezing cells to nothing. */
const MIN_GRID_WIDTH = 380;
/** Cells stretch to fill, but stop here — beyond ~20px they read as a calendar
 *  rather than a density plot. */
const MAX_CELL = 20;

export function Heatmap({
  layout,
  color = "var(--color-ember-500)",
  className,
}: {
  layout: HeatmapLayout;
  color?: string;
  className?: string;
}) {
  if (layout.cells.length === 0) return null;

  // Level 0 stays a neutral well; 1–4 ramp the goal colour up in opacity so the
  // scale reads as intensity of one hue rather than a rainbow.
  const fillFor = (level: number, isFuture: boolean) => {
    if (isFuture) return "transparent";
    if (level === 0) return "var(--color-ink-800)";
    return color;
  };
  // Level 0 is a visible neutral well, not transparent. (First version mapped it
  // to opacity 0, which made the entire grid look empty.)
  const opacityFor = (level: number) => [1, 0.3, 0.52, 0.76, 1][level] ?? 1;

  // Fractional column tracks, so the grid stretches to whatever width it is
  // given instead of sitting as a small block in a wide panel.
  const columns = `repeat(${layout.weeks}, minmax(0, 1fr))`;

  return (
    <div className={cn("overflow-x-auto pb-1", className)}>
      <div
        style={{
          minWidth: MIN_GRID_WIDTH,
          maxWidth: GUTTER + layout.weeks * (MAX_CELL + GAP),
        }}
      >
        {/* Month labels share the grid's column track, so they stay aligned. */}
        <div
          className="mb-1.5 grid"
          style={{
            gridTemplateColumns: columns,
            columnGap: `${GAP}px`,
            marginLeft: GUTTER,
          }}
          aria-hidden="true"
        >
          {layout.monthLabels.map((month) => (
            <span
              key={`${month.week}-${month.label}`}
              className="whitespace-nowrap text-[0.65rem] text-cream-600"
              // Pinned to row 1: without this, overlapping spans auto-place onto
              // new rows and the labels stair-step diagonally down the chart.
              style={{ gridRow: 1, gridColumnStart: month.week + 1 }}
            >
              {month.label}
            </span>
          ))}
        </div>

        <div className="flex gap-2">
          <div
            className="grid shrink-0 text-[0.65rem] leading-none text-cream-600"
            style={{ gridTemplateRows: "repeat(7, 1fr)", rowGap: `${GAP}px`, width: GUTTER - 8 }}
            aria-hidden="true"
          >
            {WEEKDAYS.map((day, index) => (
              <span key={index} className="flex items-center">
                {day}
              </span>
            ))}
          </div>

          <div
            className="grid flex-1"
            style={{
              gridTemplateColumns: columns,
              gridTemplateRows: "repeat(7, 1fr)",
              gap: `${GAP}px`,
            }}
            role="img"
            aria-label={`Focus heatmap over ${layout.cells.length} days. Busiest day ${formatTotal(layout.maxSeconds)}.`}
          >
            {layout.cells.map((cell) => (
              <span
                key={cell.date}
                title={`${cell.date} · ${cell.seconds > 0 ? formatTotal(cell.seconds) : "nothing logged"}`}
                className={cn(
                  "aspect-square rounded-[3px] transition-transform duration-150 hover:scale-125",
                  cell.isFuture && "border border-dashed border-ink-800",
                )}
                style={{
                  gridColumnStart: cell.week + 1,
                  gridRowStart: cell.weekday + 1,
                  background: fillFor(cell.level, cell.isFuture),
                  opacity: cell.isFuture ? 1 : opacityFor(cell.level),
                }}
              />
            ))}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 text-[0.7rem] text-cream-600">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className="h-3 w-3 rounded-[3px]"
              style={{ background: fillFor(level, false), opacity: opacityFor(level) }}
            />
          ))}
          <span>More</span>
          {layout.maxSeconds > 0 && (
            <span className="ml-2">
              Busiest day <span className="num text-cream-400">{formatTotal(layout.maxSeconds)}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Slim day-by-day bars. Small enough that a charting library isn't warranted. */
export function TrendBars({
  data,
  color = "var(--color-ember-500)",
}: {
  data: { date: string; seconds: number }[];
  color?: string;
}) {
  const peak = Math.max(...data.map((d) => d.seconds));
  const max = Math.max(1, peak);

  return (
    <div>
      {/* Bars are scaled to the peak day, so state the peak — otherwise a
          three-second day renders full height and reads as a big day. */}
      <div className="mb-2 flex items-baseline justify-between">
        <span className="label">Peak {peak > 0 ? formatTotal(peak) : "—"}</span>
        <span className="label">
          {formatTotal(data.reduce((sum, d) => sum + d.seconds, 0))} over 14 days
        </span>
      </div>
      <div className="flex h-40 items-end gap-1.5">
        {data.map((point) => {
          const pct = (point.seconds / max) * 100;
          return (
            <div
              key={point.date}
              className="group flex h-full flex-1 flex-col justify-end"
              title={`${point.date} · ${formatTotal(point.seconds)}`}
            >
              <div className="relative flex-1">
                <div
                  className="absolute inset-x-0 bottom-0 rounded-t-[3px] transition-all duration-500"
                  style={{
                    height: point.seconds > 0 ? `${Math.max(pct, 2)}%` : "2px",
                    background: point.seconds > 0 ? color : "var(--color-ink-700)",
                    opacity: point.seconds > 0 ? 0.85 : 1,
                    transitionTimingFunction: "var(--ease-instrument)",
                  }}
                />
              </div>
              <span className="num mt-2 text-center text-[0.65rem] text-cream-600">
                {point.date.slice(8)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="sr-only">
        {data.map((d) => `${d.date}: ${formatTotal(d.seconds)}`).join(". ")}
      </p>
    </div>
  );
}
