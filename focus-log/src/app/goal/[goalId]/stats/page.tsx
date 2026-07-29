"use client";

/**
 * Stats for one goal, read from the local store.
 *
 * The heatmap is plain CSS grid — d3 is gone. Besides removing ~100 kB from the
 * bundle, it lets rows be genuine weekdays and columns genuine calendar weeks,
 * which the index-based d3 layout could not do. Recharts is also gone from this
 * route; the trend below is a small inline SVG.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { listGoals, listSessions } from "@lib/store/repo";
import { currentTimeZone, formatTotal, localDateOf } from "@lib/time";
import { addDays, buildHeatmap, currentStreak } from "@lib/stats/heatmap";

const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
const DAYS_SHOWN = 120;

export default function StatsPage() {
  const params = useParams<{ goalId: string }>();
  const goalId = params.goalId;

  const goal = useLiveQuery(
    async () => (await listGoals()).find((g) => g.goal_id === goalId),
    [goalId],
    undefined,
  );
  const sessionsOrUndefined = useLiveQuery(() => listSessions({ goalId }), [goalId], undefined);
  const loading = sessionsOrUndefined === undefined;
  // Memoised so the `?? []` fallback doesn't produce a fresh array identity on
  // every render and invalidate the derived useMemos below.
  const sessions = useMemo(() => sessionsOrUndefined ?? [], [sessionsOrUndefined]);

  const timeZone = currentTimeZone();
  const today = localDateOf(new Date(), timeZone);

  const secondsByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const session of sessions) {
      map.set(session.local_date, (map.get(session.local_date) ?? 0) + session.duration_seconds);
    }
    return map;
  }, [sessions]);

  const heatmap = useMemo(
    () =>
      buildHeatmap({
        from: addDays(today, -(DAYS_SHOWN - 1)),
        to: today,
        secondsByDate,
        today,
      }),
    [secondsByDate, today],
  );

  const last14 = useMemo(() => {
    const days = Array.from({ length: 14 }, (_, i) => addDays(today, -(13 - i)));
    return days.map((date) => ({ date, seconds: secondsByDate.get(date) ?? 0 }));
  }, [secondsByDate, today]);

  const total = sessions.reduce((sum, s) => sum + s.duration_seconds, 0);
  const streak = currentStreak(secondsByDate, today);
  const activeDays = [...secondsByDate.values()].filter((s) => s > 0).length;

  if (loading) {
    return (
      <div className="goal-page-container">
        <p className="setup-help">Loading…</p>
      </div>
    );
  }

  return (
    <div className="stats-page">
      <nav className="navbar">
        <Link href="/">home</Link>
        <Link href={`/goal/${goalId}`}>timer</Link>
        <Link href="/settings">settings</Link>
      </nav>

      <header>
        <h1 className="goal-title">{goal?.title ?? "Unknown goal"}</h1>
      </header>

      <dl className="stat-tiles">
        <div>
          <dt>Total</dt>
          <dd>{formatTotal(total)}</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>{sessions.length}</dd>
        </div>
        <div>
          <dt>Active days</dt>
          <dd>{activeDays}</dd>
        </div>
        <div>
          <dt>Streak</dt>
          <dd>
            {streak} day{streak === 1 ? "" : "s"}
          </dd>
        </div>
      </dl>

      <section>
        <h2>Last {DAYS_SHOWN} days</h2>
        {heatmap.maxSeconds === 0 ? (
          <p className="setup-help">No sessions logged yet.</p>
        ) : (
          <div className="heatmap-wrap">
            <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${heatmap.weeks}, 1fr)` }}>
              {heatmap.monthLabels.map((m) => (
                <span key={`${m.week}-${m.label}`} style={{ gridColumnStart: m.week + 1 }}>
                  {m.label}
                </span>
              ))}
            </div>

            <div className="heatmap-body">
              <div className="heatmap-weekdays" aria-hidden="true">
                {WEEKDAY_LABELS.map((label, index) => (
                  <span key={index}>{label}</span>
                ))}
              </div>

              <div
                className="heatmap-grid"
                style={{ gridTemplateColumns: `repeat(${heatmap.weeks}, 1fr)` }}
                role="img"
                aria-label={`Focus heatmap: ${activeDays} active days in the last ${DAYS_SHOWN} days, ${formatTotal(total)} total.`}
              >
                {heatmap.cells.map((cell) => (
                  <span
                    key={cell.date}
                    className={`heatmap-cell level-${cell.level}${cell.isFuture ? " is-future" : ""}`}
                    style={{ gridColumnStart: cell.week + 1, gridRowStart: cell.weekday + 1 }}
                    title={`${cell.date}: ${cell.seconds > 0 ? formatTotal(cell.seconds) : "nothing logged"}`}
                  />
                ))}
              </div>
            </div>

            <div className="heatmap-legend">
              <span>Less</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <span key={level} className={`heatmap-cell level-${level}`} />
              ))}
              <span>More</span>
              <span className="setup-help">Busiest day: {formatTotal(heatmap.maxSeconds)}</span>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>Last 14 days</h2>
        <TrendBars data={last14} />
      </section>
    </div>
  );
}

/** Minimal bar chart. Not worth a charting dependency at this size. */
function TrendBars({ data }: { data: { date: string; seconds: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.seconds));
  return (
    <div className="trend">
      {data.map((point) => (
        <div key={point.date} className="trend-col" title={`${point.date}: ${formatTotal(point.seconds)}`}>
          <div className="trend-bar-track">
            <div
              className="trend-bar"
              style={{ height: `${(point.seconds / max) * 100}%` }}
              aria-hidden="true"
            />
          </div>
          <span className="trend-label">{point.date.slice(8)}</span>
        </div>
      ))}
      <p className="visually-hidden">
        {data.map((d) => `${d.date}: ${formatTotal(d.seconds)}`).join(", ")}
      </p>
    </div>
  );
}
