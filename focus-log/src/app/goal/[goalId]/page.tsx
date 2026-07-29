"use client";

/**
 * Timer screen.
 *
 * Replaces the old implementation, which counted ticks instead of reading the
 * clock (C2), forbade adjusting a duration upward (C3), deleted its local state
 * before the network write (C1), rendered "122:05" past two hours (C15), leaked
 * its interval on unmount (C5), and used alert() as its only error channel.
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { formatDuration, formatTotal } from "@lib/time";
import { deleteSession, listSessions, logSession, updateSession } from "@lib/store/repo";
import { listGoals } from "@lib/store/repo";
import { useTimer } from "@lib/timer/useTimer";
import { MAX_SESSION_SECONDS, clampAdjustment } from "@lib/timer/engine";
import { useApp } from "../../providers";

interface PendingLog {
  start: Date;
  end: Date;
  seconds: number;
  note: string;
}

export default function GoalPage() {
  const params = useParams<{ goalId: string }>();
  const goalId = params.goalId;
  const router = useRouter();
  const { connection, notifyMutation } = useApp();

  const [pending, setPending] = useState<PendingLog | undefined>();
  const [adjustMinutes, setAdjustMinutes] = useState("");
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const timer = useTimer(goalId);
  const { discard: discardTimer, stop: stopTimer } = timer;

  // Titles come from the local store, so deep-linking this page works on a cold
  // load. The old page read a localStorage cache populated only by a prior visit
  // to "/", so a direct link showed "Unknown Goal" (C16).
  const goal = useLiveQuery(
    async () => (await listGoals()).find((g) => g.goal_id === goalId),
    [goalId],
    undefined,
  );
  const sessions = useLiveQuery(() => listSessions({ goalId }), [goalId], undefined) ?? [];

  useEffect(() => {
    if (connection === "unconfigured") router.push("/setup");
  }, [connection, router]);

  const totalSeconds = sessions.reduce((sum, s) => sum + s.duration_seconds, 0);
  const goalTitle = goal?.title;

  const handleStop = useCallback(async () => {
    const result = await stopTimer();
    if (!result) return;
    setPending(result);
    setAdjustMinutes(String(Math.round(result.seconds / 60)));
  }, [stopTimer]);

  const commit = useCallback(
    async (seconds: number) => {
      if (!pending) return;
      setError(undefined);
      try {
        await logSession({
          goal_id: goalId,
          start: pending.start,
          end: pending.end,
          note: pending.note,
          durationSecondsOverride: seconds,
          source: "timer",
        });
        // Only release the running timer once the session is committed locally.
        await discardTimer();
        setPending(undefined);
        setMessage(`Logged ${formatTotal(seconds)} for ${goalTitle ?? "this goal"}.`);
        notifyMutation();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [pending, goalId, goalTitle, discardTimer, notifyMutation],
  );

  const adjustedSeconds = clampAdjustment(Number(adjustMinutes) * 60);
  const adjustInvalid = adjustMinutes !== "" && !Number.isFinite(Number(adjustMinutes));

  return (
    <div className="goal-page-container">
      <nav className="navbar">
        <Link href="/">home</Link>
        <Link href="/settings">settings</Link>
      </nav>

      <header>
        <h1 className="goal-title">{goal?.title ?? (timer.ready ? "Unknown goal" : "…")}</h1>
        <p className="goal-subtitle">
          {sessions.length} session{sessions.length === 1 ? "" : "s"} · {formatTotal(totalSeconds)} total
        </p>
      </header>

      <div className="timer-display" aria-live="off">
        <p>{formatDuration(timer.seconds)}</p>
        <span className="timer-phase">
          {timer.phase === "running" ? "focusing" : timer.phase === "paused" ? "paused" : "ready"}
        </span>
      </div>

      <div className="button-group">
        {timer.phase === "idle" && (
          <button
            type="button"
            onClick={() => void timer.start()}
            disabled={timer.blockedByOtherGoal || !timer.ready}
            className="btn start-btn"
          >
            Start
          </button>
        )}
        {timer.phase === "running" && (
          <button type="button" onClick={() => void timer.pause()} className="btn">
            Pause
          </button>
        )}
        {timer.phase === "paused" && (
          <button type="button" onClick={() => void timer.resume()} className="btn start-btn">
            Resume
          </button>
        )}
        {timer.phase !== "idle" && (
          <button type="button" onClick={() => void handleStop()} className="btn stop-btn">
            Stop
          </button>
        )}
      </div>

      {timer.blockedByOtherGoal && (
        <p className="warning-message" role="status">
          A timer is running for another goal.{" "}
          <Link href={`/goal/${timer.activeGoalId}`}>Go to it</Link> to stop it first.
        </p>
      )}

      {timer.warning && !pending && (
        <p className="warning-message" role="status">
          {timer.warning.message}
        </p>
      )}

      {message && (
        <p className="success-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}

      {pending && (
        <div className="modal-overlay">
          {/* Radix-based dialog with a real focus trap lands in Part B; for now
              at least declare the role and label so it is announced. */}
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="log-title">
            <h2 id="log-title">Log this session?</h2>
            <p>
              You focused for <strong>{formatTotal(pending.seconds)}</strong>
              {pending.seconds < 60 && " — that's under a minute"}.
            </p>

            <div className="modal-buttons">
              <button type="button" className="btn log-btn" onClick={() => void commit(pending.seconds)}>
                Log {formatTotal(pending.seconds)}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  // Back to a paused timer rather than losing the session. The
                  // old modal had no exit that kept the session alive.
                  setPending(undefined);
                }}
              >
                Keep timing
              </button>
            </div>

            <hr className="modal-divider" />

            <div className="adjust-section">
              <label htmlFor="adjust">Or log a different duration (minutes)</label>
              <div className="adjust-controls">
                <input
                  id="adjust"
                  type="number"
                  min={0}
                  max={MAX_SESSION_SECONDS / 60}
                  value={adjustMinutes}
                  onChange={(event) => setAdjustMinutes(event.target.value)}
                  className={`adjust-input${adjustInvalid ? " input-error" : ""}`}
                  aria-describedby="adjust-help"
                />
                <button
                  type="button"
                  className="btn adjust-save-btn"
                  disabled={adjustInvalid}
                  onClick={() => void commit(adjustedSeconds)}
                >
                  Log {formatTotal(adjustedSeconds)}
                </button>
              </div>
              <p id="adjust-help" className="setup-help">
                You can enter more than the recorded time — useful if the tab was in the background
                and under-counted.
              </p>
            </div>

            <button
              type="button"
              className="btn discard-btn"
              onClick={() => {
                void (async () => {
                  await discardTimer();
                  setPending(undefined);
                  setMessage("Session discarded.");
                })();
              }}
            >
              Discard session
            </button>
          </div>
        </div>
      )}

      <section className="session-list">
        <h2>Recent sessions</h2>
        {sessions.length === 0 ? (
          <p className="setup-help">No sessions yet. Press Start to log your first one.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Duration</th>
                <th scope="col">Note</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.slice(0, 30).map((session) => (
                <tr key={session.log_id}>
                  <td>{session.local_date}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      aria-label={`Minutes for the session on ${session.local_date}`}
                      className="adjust-input"
                      defaultValue={Math.round(session.duration_seconds / 60)}
                      onBlur={(event) => {
                        const seconds = clampAdjustment(Number(event.target.value) * 60);
                        if (seconds !== session.duration_seconds) {
                          void (async () => {
                            await updateSession(session.log_id, { duration_seconds: seconds });
                            notifyMutation();
                          })();
                        }
                      }}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Note for the session on ${session.local_date}`}
                      className="input-field"
                      defaultValue={session.note}
                      onBlur={(event) => {
                        if (event.target.value !== session.note) {
                          void (async () => {
                            await updateSession(session.log_id, { note: event.target.value });
                            notifyMutation();
                          })();
                        }
                      }}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn discard-btn"
                      onClick={() => {
                        void (async () => {
                          await deleteSession(session.log_id);
                          notifyMutation();
                        })();
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
