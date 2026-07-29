"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Timer } from "lucide-react";
import { listGoals, listSessions } from "@lib/store/repo";
import { currentTimeZone, formatTotal, localDateOf } from "@lib/time";
import { addDays, buildHeatmap, currentStreak } from "@lib/stats/heatmap";
import { Button, Panel, Stat, goalColor } from "@/components/ui";
import { Heatmap, TrendBars } from "@/components/heatmap";

const DAYS_SHOWN = 181; // 26 whole weeks, half a year

export default function GoalStatsPage() {
  const { goalId } = useParams<{ goalId: string }>();

  const goal = useLiveQuery(
    async () => (await listGoals()).find((g) => g.goal_id === goalId),
    [goalId],
    undefined,
  );
  const sessionsOrUndefined = useLiveQuery(() => listSessions({ goalId }), [goalId], undefined);
  const loading = sessionsOrUndefined === undefined;
  // Memoised so the `?? []` fallback doesn't produce a new array identity each
  // render and invalidate everything derived from it.
  const sessions = useMemo(() => sessionsOrUndefined ?? [], [sessionsOrUndefined]);

  const timeZone = currentTimeZone();
  const today = localDateOf(new Date(), timeZone);
  const color = goalColor(goalId, goal?.color);

  const secondsByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const session of sessions) {
      map.set(session.local_date, (map.get(session.local_date) ?? 0) + session.duration_seconds);
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

  const total = sessions.reduce((sum, s) => sum + s.duration_seconds, 0);
  const activeDays = [...secondsByDate.values()].filter((s) => s > 0).length;
  const streak = currentStreak(secondsByDate, today);
  const median = useMemo(() => {
    if (sessions.length === 0) return 0;
    const sorted = [...sessions].map((s) => s.duration_seconds).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }, [sessions]);

  return (
    <div className="mx-auto max-w-[1100px] px-5 py-6 md:px-8 md:py-8">
      <div className="flex items-center justify-between gap-4">
        <Link
          href={`/goal/${goalId}`}
          className="group flex items-center gap-2 text-sm text-cream-400 transition-colors hover:text-cream-50"
        >
          <ArrowLeft
            size={15}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          Timer
        </Link>
        <Link href={`/goal/${goalId}`}>
          <Button variant="ghost" size="sm">
            <Timer size={14} />
            Start a session
          </Button>
        </Link>
      </div>

      <header className="rise mt-6" style={{ "--i": 0 } as React.CSSProperties}>
        <p className="label">Insights</p>
        <h1 className="mt-1.5 flex items-center gap-3 font-display text-4xl text-cream-50">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: color, boxShadow: `0 0 12px -1px ${color}` }}
          />
          {goal?.title ?? "Unknown goal"}
        </h1>
      </header>

      {loading ? (
        <p className="label mt-8">Loading</p>
      ) : (
        <>
          <div
            className="rise mt-7 grid grid-cols-2 gap-3 md:grid-cols-5"
            style={{ "--i": 1 } as React.CSSProperties}
          >
            <Stat label="All time" value={formatTotal(total)} accent />
            <Stat label="Sessions" value={sessions.length} />
            <Stat label="Typical" value={formatTotal(median)} sub="median session" />
            <Stat label="Active days" value={activeDays} />
            <Stat label="Streak" value={`${streak}d`} />
          </div>

          <section className="rise mt-10" style={{ "--i": 2 } as React.CSSProperties}>
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="font-display text-2xl text-cream-50">Last 26 weeks</h2>
              <span className="label">
                {activeDays} active day{activeDays === 1 ? "" : "s"}
              </span>
            </div>
            <Panel className="w-fit max-w-full p-5">
              {total === 0 ? (
                <p className="py-6 text-center text-sm text-cream-400">
                  Nothing logged yet for this goal.
                </p>
              ) : (
                <Heatmap layout={layout} color={color} />
              )}
            </Panel>
          </section>

          <section className="rise mt-10" style={{ "--i": 3 } as React.CSSProperties}>
            <h2 className="mb-4 font-display text-2xl text-cream-50">Last 14 days</h2>
            <Panel className="p-5">
              <TrendBars data={last14} color={color} />
            </Panel>
          </section>
        </>
      )}
    </div>
  );
}
