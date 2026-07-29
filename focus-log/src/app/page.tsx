"use client";

/**
 * Today.
 *
 * Reads entirely from the local store, so it renders instantly and works
 * offline. Layout is deliberately asymmetric — a tall "today" instrument panel
 * on the left, the goal ledger on the right — rather than the centred column of
 * identical cards the old version used.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowRight, BarChart3, Plus, Play } from "lucide-react";
import { listGoals, listSessions, totalsByGoal } from "@lib/store/repo";
import type { Goal } from "@lib/sheets/schema";
import { currentTimeZone, formatTotal, localDateOf } from "@lib/time";
import { timerStore } from "@lib/timer/store";
import { addDays, buildHeatmap, currentStreak, startOfWeek } from "@lib/stats/heatmap";
import { Button, Meter, Panel, cn, goalColor } from "@/components/ui";
import { Heatmap } from "@/components/heatmap";
import { BackfillDialog } from "./backfill-dialog";
import { useApp } from "./providers";

export default function TodayPage() {
  const router = useRouter();
  const { connection } = useApp();
  const [backfillFor, setBackfillFor] = useState<Goal | undefined>();

  const timeZone = currentTimeZone();
  const today = localDateOf(new Date(), timeZone);
  const weekStart = startOfWeek(today);

  // Live queries re-run on any IndexedDB change, so a background sync pulling
  // sessions from another device updates these totals with no refetch wiring.
  const goals = useLiveQuery(() => listGoals(), [], undefined);
  const todayTotals = useLiveQuery(() => totalsByGoal({ from: today, to: today }), [today], undefined);
  const weekTotals = useLiveQuery(() => totalsByGoal({ from: weekStart }), [weekStart], undefined);
  const allSessions = useLiveQuery(() => listSessions({}), [], undefined);

  const activeGoalId = useSyncExternalStore(
    (onChange) => timerStore().subscribe(() => onChange()),
    () => timerStore().snapshot()?.goalId,
    () => undefined,
  );

  useEffect(() => {
    if (connection === "unconfigured") router.push("/setup");
  }, [connection, router]);

  useEffect(() => {
    void timerStore().load();
  }, []);

  const secondsByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of allSessions ?? []) {
      map.set(s.local_date, (map.get(s.local_date) ?? 0) + s.duration_seconds);
    }
    return map;
  }, [allSessions]);

  const todayAll = [...(todayTotals?.values() ?? [])].reduce((a, b) => a + b, 0);
  const weekAll = [...(weekTotals?.values() ?? [])].reduce((a, b) => a + b, 0);
  const streak = currentStreak(secondsByDate, today);
  const weekTargetSeconds = (goals ?? []).reduce((sum, g) => sum + g.weekly_target_minutes * 60, 0);

  // Nine weeks is enough to see a habit forming without dominating the page.
  const recent = useMemo(
    () => buildHeatmap({ from: addDays(today, -62), to: today, secondsByDate, today }),
    [secondsByDate, today],
  );
  const loggedAnything = [...secondsByDate.values()].some((s) => s > 0);

  if (connection === "loading" || goals === undefined) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <p className="label">Loading</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8 md:px-8 md:py-12">
      <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_1fr] lg:gap-8">
        {/* ---------------- today panel ---------------- */}
        <div className="rise space-y-6" style={{ "--i": 0 } as React.CSSProperties}>
          <div>
            <p className="label">
              {new Date().toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </p>
            <h1 className="mt-2 font-display text-[2.75rem] leading-[0.95] text-cream-50">
              Today
            </h1>
          </div>

          <Panel className="relative overflow-hidden p-6">
            {/* Ember bloom, brighter once there is something to show for the day. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full transition-opacity duration-1000"
              style={{
                background:
                  "radial-gradient(circle, rgba(255,122,24,0.22), transparent 65%)",
                opacity: todayAll > 0 ? 1 : 0.25,
              }}
            />
            <p className="label relative">Focused today</p>
            <p
              className={cn(
                "num relative mt-2 text-[3.25rem] leading-none tracking-tighter",
                todayAll > 0 ? "text-cream-50" : "text-cream-600",
              )}
            >
              {formatTotal(todayAll)}
            </p>

            <div className="seam my-5" />

            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="label">This week</dt>
                <dd className="num mt-1 text-lg text-cream-200">{formatTotal(weekAll)}</dd>
              </div>
              <div>
                <dt className="label">Streak</dt>
                <dd className="num mt-1 text-lg text-cream-200">
                  {streak}
                  <span className="ml-1 font-sans text-xs text-cream-600">
                    day{streak === 1 ? "" : "s"}
                  </span>
                </dd>
              </div>
            </dl>

            {weekTargetSeconds > 0 && (
              <div className="mt-5 space-y-2">
                <div className="flex items-baseline justify-between">
                  <span className="label">Weekly target</span>
                  <span className="num text-xs text-cream-400">
                    {Math.round((weekAll / weekTargetSeconds) * 100)}%
                  </span>
                </div>
                <Meter
                  value={weekAll}
                  max={weekTargetSeconds}
                  label={`Weekly target: ${Math.round((weekAll / weekTargetSeconds) * 100)}% complete`}
                />
              </div>
            )}
          </Panel>

          <Link
            href="/stats"
            className="group flex items-center gap-2 text-sm text-cream-400 transition-colors hover:text-ember-400"
          >
            <BarChart3 size={15} strokeWidth={1.75} />
            See all insights
            <ArrowRight
              size={14}
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </Link>
        </div>

        {/* ---------------- goal ledger ---------------- */}
        <div className="rise min-w-0" style={{ "--i": 1 } as React.CSSProperties}>
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="font-display text-2xl text-cream-50">Goals</h2>
            <Link
              href="/settings"
              className="flex items-center gap-1.5 text-sm text-cream-400 transition-colors hover:text-cream-50"
            >
              <Plus size={14} />
              Manage
            </Link>
          </div>

          {goals.length === 0 ? (
            <Panel className="px-6 py-14 text-center">
              <h3 className="font-display text-xl text-cream-50">Nothing to track yet</h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-cream-400">
                Add your first goal — something you want to give real, measured attention to
                this quarter.
              </p>
              <Link href="/settings" className="mt-5 inline-block">
                <Button variant="primary">
                  <Plus size={15} />
                  Add a goal
                </Button>
              </Link>
            </Panel>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {goals.map((goal, index) => (
                <li
                  key={goal.goal_id}
                  className="rise"
                  style={{ "--i": index + 2 } as React.CSSProperties}
                >
                  <GoalCard
                    goal={goal}
                    todaySeconds={todayTotals?.get(goal.goal_id) ?? 0}
                    weekSeconds={weekTotals?.get(goal.goal_id) ?? 0}
                    isActive={goal.goal_id === activeGoalId}
                    onBackfill={() => setBackfillFor(goal)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {loggedAnything && (
        <section
          className="rise mt-10"
          style={{ "--i": 4 } as React.CSSProperties}
        >
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="font-display text-2xl text-cream-50">Recent</h2>
            <Link
              href="/stats"
              className="text-sm text-cream-400 transition-colors hover:text-ember-400"
            >
              Full history
            </Link>
          </div>
          <Panel className="w-fit max-w-full p-5">
            <Heatmap layout={recent} />
          </Panel>
        </section>
      )}

      {backfillFor && (
        <BackfillDialog
          goal={backfillFor}
          open
          onOpenChange={(open) => !open && setBackfillFor(undefined)}
        />
      )}
    </div>
  );
}

function GoalCard({
  goal,
  todaySeconds,
  weekSeconds,
  isActive,
  onBackfill,
}: {
  goal: Goal;
  todaySeconds: number;
  weekSeconds: number;
  isActive: boolean;
  onBackfill: () => void;
}) {
  const color = goalColor(goal.goal_id, goal.color);
  const targetSeconds = goal.weekly_target_minutes * 60;

  return (
    <Panel
      interactive
      className={cn(
        "group relative flex h-full flex-col overflow-hidden p-5",
        isActive && "border-ember-500/45",
      )}
    >
      {/* Colour seam along the top edge identifies the goal at a glance. */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px opacity-70"
        style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }}
      />

      {isActive && (
        <span className="absolute right-4 top-4 flex items-center gap-1.5">
          <span className="breathe h-1.5 w-1.5 rounded-full bg-ember-500" />
          <span className="label !text-ember-400">Live</span>
        </span>
      )}

      <Link href={`/goal/${goal.goal_id}`} className="min-w-0">
        <h3 className="truncate pr-14 font-display text-xl leading-tight text-cream-50 transition-colors group-hover:text-ember-300">
          {goal.title}
        </h3>
      </Link>

      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="num text-2xl leading-none text-cream-50">{formatTotal(todaySeconds)}</span>
        <span className="text-xs text-cream-600">today</span>
      </div>

      <p className="mt-1 text-xs text-cream-600">
        <span className="num">{formatTotal(weekSeconds)}</span> this week
        {targetSeconds > 0 && (
          <>
            {" of "}
            <span className="num">{formatTotal(targetSeconds)}</span>
          </>
        )}
      </p>

      {targetSeconds > 0 && (
        <Meter
          value={weekSeconds}
          max={targetSeconds}
          color={color}
          label={`${goal.title}: weekly target progress`}
          className="mt-3"
        />
      )}

      <div className="mt-5 flex items-center gap-2 pt-1">
        <Link href={`/goal/${goal.goal_id}`} className="flex-1">
          <Button variant={isActive ? "primary" : "default"} size="sm" className="w-full">
            <Play size={13} strokeWidth={2.5} />
            {isActive ? "Resume" : "Focus"}
          </Button>
        </Link>
        <Button variant="ghost" size="sm" onClick={onBackfill} title="Add a past session">
          <Plus size={14} />
        </Button>
        <Link href={`/goal/${goal.goal_id}/stats`}>
          <Button variant="ghost" size="sm" title="Goal insights">
            <BarChart3 size={14} />
          </Button>
        </Link>
      </div>
    </Panel>
  );
}
