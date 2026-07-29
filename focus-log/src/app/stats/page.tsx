"use client";

/**
 * Cross-goal insights. New — the old app had per-goal charts only, with no way
 * to see how attention was actually distributed.
 */

import Link from "next/link";
import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { listGoals, listSessions } from "@lib/store/repo";
import { currentTimeZone, formatTotal, localDateOf } from "@lib/time";
import { addDays, buildHeatmap, currentStreak } from "@lib/stats/heatmap";
import { Panel, Stat, goalColor } from "@/components/ui";
import { Heatmap, TrendBars } from "@/components/heatmap";
import { startOfWeek } from "../page";

const DAYS_SHOWN = 181; // 26 whole weeks

export default function InsightsPage() {
  const goals = useLiveQuery(() => listGoals(), [], undefined);
  const sessionsOrUndefined = useLiveQuery(() => listSessions({}), [], undefined);
  const sessions = useMemo(() => sessionsOrUndefined ?? [], [sessionsOrUndefined]);

  const timeZone = currentTimeZone();
  const today = localDateOf(new Date(), timeZone);
  const weekStart = startOfWeek(new Date(), timeZone);

  const secondsByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      map.set(s.local_date, (map.get(s.local_date) ?? 0) + s.duration_seconds);
    }
    return map;
  }, [sessions]);

  const layout = useMemo(
    () =>
      buildHeatmap({
        from: addDays(today, -(DAYS_SHOWN - 1)),
        to: today,
        secondsByDate,
        today,
      }),
    [secondsByDate, today],
  );

  const last14 = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => {
        const date = addDays(today, -(13 - i));
        return { date, seconds: secondsByDate.get(date) ?? 0 };
      }),
    [secondsByDate, today],
  );

  /** Share of attention per goal, all time and this week. */
  const split = useMemo(() => {
    const all = new Map<string, number>();
    const week = new Map<string, number>();
    for (const s of sessions) {
      all.set(s.goal_id, (all.get(s.goal_id) ?? 0) + s.duration_seconds);
      if (s.local_date >= weekStart) {
        week.set(s.goal_id, (week.get(s.goal_id) ?? 0) + s.duration_seconds);
      }
    }
    const total = [...all.values()].reduce((a, b) => a + b, 0);
    return (goals ?? [])
      .map((goal) => ({
        goal,
        all: all.get(goal.goal_id) ?? 0,
        week: week.get(goal.goal_id) ?? 0,
        share: total > 0 ? ((all.get(goal.goal_id) ?? 0) / total) * 100 : 0,
        color: goalColor(goal.goal_id, goal.color),
      }))
      .sort((a, b) => b.all - a.all);
  }, [sessions, goals, weekStart]);

  const total = sessions.reduce((sum, s) => sum + s.duration_seconds, 0);
  const activeDays = [...secondsByDate.values()].filter((s) => s > 0).length;
  const streak = currentStreak(secondsByDate, today);
  const weekTotal = sessions
    .filter((s) => s.local_date >= weekStart)
    .reduce((sum, s) => sum + s.duration_seconds, 0);

  if (goals === undefined || sessionsOrUndefined === undefined) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <p className="label">Loading</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1100px] px-5 py-8 md:px-8 md:py-12">
      <header className="rise" style={{ "--i": 0 } as React.CSSProperties}>
        <p className="label">All goals</p>
        <h1 className="mt-1.5 font-display text-4xl text-cream-50">Insights</h1>
      </header>

      <div
        className="rise mt-7 grid grid-cols-2 gap-3 md:grid-cols-4"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <Stat label="All time" value={formatTotal(total)} accent />
        <Stat label="This week" value={formatTotal(weekTotal)} />
        <Stat label="Active days" value={activeDays} />
        <Stat label="Streak" value={`${streak}d`} />
      </div>

      <section className="rise mt-10" style={{ "--i": 2 } as React.CSSProperties}>
        <h2 className="mb-4 font-display text-2xl text-cream-50">Last 26 weeks</h2>
        <Panel className="w-fit max-w-full p-5">
          {total === 0 ? (
            <p className="py-6 text-center text-sm text-cream-400">
              Nothing logged yet. Start a session from{" "}
              <Link href="/" className="text-ember-400 underline underline-offset-4">
                Today
              </Link>
              .
            </p>
          ) : (
            <Heatmap layout={layout} />
          )}
        </Panel>
      </section>

      <section className="rise mt-10" style={{ "--i": 3 } as React.CSSProperties}>
        <h2 className="mb-4 font-display text-2xl text-cream-50">Where attention went</h2>
        {split.length === 0 || total === 0 ? (
          <Panel className="p-5">
            <p className="py-4 text-center text-sm text-cream-400">No sessions to compare yet.</p>
          </Panel>
        ) : (
          <Panel className="overflow-hidden p-5">
            {/* Single stacked bar: proportion is easier to read than five separate
                bars when the question is "what got the time". */}
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-ink-800">
              {split
                .filter((row) => row.all > 0)
                .map((row) => (
                  <div
                    key={row.goal.goal_id}
                    className="h-full transition-[width] duration-700 first:rounded-l-full last:rounded-r-full"
                    style={{ width: `${row.share}%`, background: row.color }}
                    title={`${row.goal.title}: ${row.share.toFixed(0)}%`}
                  />
                ))}
            </div>

            <ul className="mt-5 space-y-3">
              {split.map((row) => (
                <li key={row.goal.goal_id} className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: row.color }}
                  />
                  <Link
                    href={`/goal/${row.goal.goal_id}/stats`}
                    className="min-w-0 flex-1 truncate text-sm text-cream-200 underline-offset-4 hover:underline"
                  >
                    {row.goal.title}
                  </Link>
                  <span className="num shrink-0 text-xs text-cream-600">
                    {formatTotal(row.week)} wk
                  </span>
                  <span className="num w-20 shrink-0 text-right text-sm text-cream-50">
                    {formatTotal(row.all)}
                  </span>
                  <span className="num w-10 shrink-0 text-right text-xs text-cream-600">
                    {row.share.toFixed(0)}%
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </section>

      <section className="rise mt-10" style={{ "--i": 4 } as React.CSSProperties}>
        <h2 className="mb-4 font-display text-2xl text-cream-50">Last 14 days</h2>
        <Panel className="p-5">
          <TrendBars data={last14} />
        </Panel>
      </section>
    </div>
  );
}
