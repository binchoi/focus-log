"use client";

/**
 * Home. Reads entirely from the local store, so it renders instantly and works
 * offline. The old version fetched two ranges from Sheets on mount and had no
 * loading, empty, or error state — a failed fetch left a permanently blank grid
 * with only a console error.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { listGoals, logSession, totalsByGoal } from "@lib/store/repo";
import type { Goal } from "@lib/sheets/schema";
import { currentTimeZone, formatTotal, localDateOf } from "@lib/time";
import { timerStore } from "@lib/timer/store";
import { useApp } from "./providers";
import { SyncBadge } from "./sync-badge";

/** Monday-based start of the week containing `date`, as a local date string. */
function startOfWeek(date: Date, timeZone: string): string {
  const today = localDateOf(date, timeZone);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (weekday + 6) % 7;
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
}

export default function HomePage() {
  const router = useRouter();
  const { connection, notifyMutation } = useApp();

  const [backfillFor, setBackfillFor] = useState<Goal | undefined>();

  // Live queries re-run whenever IndexedDB changes, so a background sync pulling
  // new sessions updates these totals with no manual refetch.
  const goals = useLiveQuery(() => listGoals(), [], undefined);
  const todayTotals = useLiveQuery(() => {
    const today = localDateOf(new Date(), currentTimeZone());
    return totalsByGoal({ from: today, to: today });
  }, [], undefined);
  const weekTotals = useLiveQuery(
    () => totalsByGoal({ from: startOfWeek(new Date(), currentTimeZone()) }),
    [],
    undefined,
  );

  // Keep the "active goal" highlight live across tabs. The old page read this
  // once on mount and never updated (C11).
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

  const todayAll = [...(todayTotals?.values() ?? [])].reduce((a, b) => a + b, 0);

  if (connection === "loading" || goals === undefined) {
    return (
      <div className="homepage-container">
        <p className="setup-help">Loading…</p>
      </div>
    );
  }

  return (
    <div className="homepage-container">
      <header className="home-header">
        <h1 className="app-title">Focus Log</h1>
        <p className="home-today">
          {todayAll > 0 ? `${formatTotal(todayAll)} focused today` : "Nothing logged today yet"}
        </p>
        <SyncBadge />
        <Link href="/settings" className="home-settings-link">
          settings
        </Link>
      </header>

      {goals.length === 0 ? (
        <section className="empty-state">
          <h2>No goals yet</h2>
          <p>Create your first goal to start logging focus time.</p>
          <Link href="/settings" className="btn save-btn">
            Add a goal
          </Link>
        </section>
      ) : (
        <div className="goals-grid">
          {goals.map((goal) => {
            const today = todayTotals?.get(goal.goal_id) ?? 0;
            const week = weekTotals?.get(goal.goal_id) ?? 0;
            const targetSeconds = goal.weekly_target_minutes * 60;
            const progress = targetSeconds > 0 ? Math.min(100, (week / targetSeconds) * 100) : undefined;

            return (
              <div
                key={goal.goal_id}
                className={`goal-card${goal.goal_id === activeGoalId ? " active-goal" : ""}`}
              >
                <div className="goal-content">
                  <Link href={`/goal/${goal.goal_id}`}>
                    <h2>{goal.title}</h2>
                  </Link>
                  <p>
                    {formatTotal(today)} today · {formatTotal(week)} this week
                  </p>

                  {progress !== undefined && (
                    <div
                      className="goal-progress"
                      role="progressbar"
                      aria-valuenow={Math.round(progress)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${goal.title}: ${Math.round(progress)}% of weekly target`}
                    >
                      <span style={{ width: `${progress}%`, backgroundColor: goal.color }} />
                    </div>
                  )}

                  <div className="goal-card-actions">
                    <Link href={`/goal/${goal.goal_id}`} className="btn start-btn">
                      {goal.goal_id === activeGoalId ? "Resume" : "Start"}
                    </Link>
                    <Link href={`/goal/${goal.goal_id}/stats`} className="btn">
                      Stats
                    </Link>
                    <button type="button" className="btn" onClick={() => setBackfillFor(goal)}>
                      Add past
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {backfillFor && (
        <BackfillDialog
          goal={backfillFor}
          onClose={() => setBackfillFor(undefined)}
          onSaved={() => {
            setBackfillFor(undefined);
            notifyMutation();
          }}
        />
      )}
    </div>
  );
}

/**
 * Manual entry for a session that happened away from the app. Previously this
 * required typing a row into the spreadsheet by hand.
 */
function BackfillDialog({
  goal,
  onClose,
  onSaved,
}: {
  goal: Goal;
  onClose: () => void;
  onSaved: () => void;
}) {
  const timeZone = currentTimeZone();
  const [date, setDate] = useState(() => localDateOf(new Date(), timeZone));
  const [time, setTime] = useState("09:00");
  const [minutes, setMinutes] = useState("30");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      // Interpreted in the browser's current zone, which is what the user means
      // by "9am on the 20th".
      const start = new Date(`${date}T${time}`);
      if (Number.isNaN(start.getTime())) throw new Error("That date or time isn't valid.");
      const duration = Number(minutes);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Enter how many minutes you focused.");
      }
      if (start.getTime() > Date.now()) throw new Error("That start time is in the future.");

      await logSession({
        goal_id: goal.goal_id,
        start,
        end: new Date(start.getTime() + duration * 60_000),
        note,
        source: "manual",
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="backfill-title">
        <h2 id="backfill-title">Add a past session to {goal.title}</h2>

        <label htmlFor="bf-date">Date</label>
        <input
          id="bf-date"
          type="date"
          className="input-field"
          value={date}
          max={localDateOf(new Date(), timeZone)}
          onChange={(event) => setDate(event.target.value)}
        />

        <label htmlFor="bf-time">Start time</label>
        <input
          id="bf-time"
          type="time"
          className="input-field"
          value={time}
          onChange={(event) => setTime(event.target.value)}
        />

        <label htmlFor="bf-minutes">Minutes focused</label>
        <input
          id="bf-minutes"
          type="number"
          min={1}
          className="input-field"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
        />

        <label htmlFor="bf-note">Note (optional)</label>
        <input
          id="bf-note"
          className="input-field"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />

        {error && (
          <p className="setup-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-buttons">
          <button type="button" className="btn log-btn" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Add session"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
