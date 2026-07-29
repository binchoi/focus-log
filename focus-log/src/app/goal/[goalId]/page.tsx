"use client";

/**
 * The timer.
 *
 * This screen is the app. The numerals are the hero object: oversized, tabular
 * mono, with a filament bloom behind them that breathes while a session runs and
 * dims when paused. Everything else is deliberately quiet.
 *
 * Replaces an implementation that counted interval ticks rather than reading the
 * clock (C2), refused upward adjustment (C3), deleted local state before the
 * network write (C1), rendered "122:05" past two hours (C15), leaked its interval
 * (C5), and used alert() as its only error channel.
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, BarChart3, Pause, Play, Square, Trash2 } from "lucide-react";
import { formatDuration, formatTotal } from "@lib/time";
import { deleteSession, listGoals, listSessions, logSession, updateSession } from "@lib/store/repo";
import { useTimer } from "@lib/timer/useTimer";
import { MAX_SESSION_SECONDS, clampAdjustment } from "@lib/timer/engine";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  Panel,
  cn,
  goalColor,
} from "@/components/ui";
import { useApp } from "../../providers";

interface PendingLog {
  start: Date;
  end: Date;
  seconds: number;
  note: string;
}

export default function GoalPage() {
  const { goalId } = useParams<{ goalId: string }>();
  const router = useRouter();
  const { connection, notifyMutation } = useApp();

  const [pending, setPending] = useState<PendingLog | undefined>();
  const [adjustMinutes, setAdjustMinutes] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const timer = useTimer(goalId);
  const { discard: discardTimer, stop: stopTimer } = timer;

  // From the local store, so a deep link works on a cold load. The old page read
  // a localStorage cache populated only by a prior visit to "/" (C16).
  const goal = useLiveQuery(
    async () => (await listGoals()).find((g) => g.goal_id === goalId),
    [goalId],
    undefined,
  );
  const sessions = useLiveQuery(() => listSessions({ goalId }), [goalId], undefined);

  useEffect(() => {
    if (connection === "unconfigured") router.push("/setup");
  }, [connection, router]);

  const totalSeconds = (sessions ?? []).reduce((sum, s) => sum + s.duration_seconds, 0);
  const goalTitle = goal?.title;
  const color = goalColor(goalId, goal?.color);

  const handleStop = useCallback(async () => {
    const result = await stopTimer();
    if (!result) return;
    setPending(result);
    setAdjustMinutes(String(Math.round(result.seconds / 60)));
    setNote(result.note);
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
          note,
          durationSecondsOverride: seconds,
          source: "timer",
        });
        // Only release the running session once it is committed locally.
        await discardTimer();
        setPending(undefined);
        setNote("");
        setMessage(`Logged ${formatTotal(seconds)} to ${goalTitle ?? "this goal"}.`);
        notifyMutation();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [pending, goalId, goalTitle, note, discardTimer, notifyMutation],
  );

  const { phase, ready, blockedByOtherGoal } = timer;
  const startTimer = timer.start;
  const pauseTimer = timer.pause;
  const resumeTimer = timer.resume;

  // Space toggles start/pause — the one shortcut that matters here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || pending) return;
      const el = event.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(el.tagName)) return;
      event.preventDefault();
      if (phase === "idle") void startTimer();
      else if (phase === "running") void pauseTimer();
      else void resumeTimer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, pending, startTimer, pauseTimer, resumeTimer]);

  const adjustedSeconds = clampAdjustment(Number(adjustMinutes) * 60);
  const adjustInvalid = adjustMinutes.trim() !== "" && !Number.isFinite(Number(adjustMinutes));

  const [minutesPart, secondsPart] = useMemo(() => {
    const text = formatDuration(timer.seconds);
    const index = text.lastIndexOf(":");
    return [text.slice(0, index), text.slice(index + 1)];
  }, [timer.seconds]);

  const running = phase === "running";
  const paused = phase === "paused";

  return (
    <div className="mx-auto max-w-[1100px] px-5 py-6 md:px-8">
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/"
          className="group flex items-center gap-2 text-sm text-cream-400 transition-colors hover:text-cream-50"
        >
          <ArrowLeft
            size={15}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          Today
        </Link>
        <Link href={`/goal/${goalId}/stats`}>
          <Button variant="ghost" size="sm">
            <BarChart3 size={14} />
            Insights
          </Button>
        </Link>
      </div>

      {/* ---------------- the instrument ---------------- */}
      <section className="relative flex flex-col items-center overflow-hidden pb-10 pt-12 md:pt-16">
        {/* Filament bloom. Breathes while running, still and dim when paused. */}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[26rem] w-[26rem] -translate-x-1/2 -translate-y-[58%] rounded-full transition-opacity duration-1000",
            running && "breathe",
          )}
          style={{
            background: `radial-gradient(circle, ${color}2e, transparent 62%)`,
            opacity: running ? 1 : paused ? 0.45 : 0.16,
          }}
        />

        <p className="label h-4">{goal ? "Focusing on" : ""}</p>
        <h1 className="mt-1.5 max-w-[24ch] text-center font-display text-3xl leading-tight text-cream-50 md:text-4xl">
          {goal?.title ?? (ready ? "Unknown goal" : " ")}
        </h1>

        <p className="mt-2 text-xs text-cream-600">
          <span className="num">{sessions?.length ?? 0}</span> session
          {(sessions?.length ?? 0) === 1 ? "" : "s"} ·{" "}
          <span className="num">{formatTotal(totalSeconds)}</span> all time
        </p>

        {/* Minutes stay steady; seconds get a subtle per-tick lift, so the
            display feels alive without anything actually moving. */}
        <div className="num mt-8 flex items-baseline tabular-nums" aria-live="off">
          <span
            className={cn(
              "text-[clamp(4.5rem,15vw,9rem)] font-medium leading-[0.85] tracking-tighter transition-colors duration-500",
              running || paused ? "text-cream-50" : "text-ink-500",
            )}
          >
            {minutesPart}
          </span>
          <span
            className={cn(
              "text-[clamp(4.5rem,15vw,9rem)] font-medium leading-[0.85] tracking-tighter",
              running || paused ? "text-cream-50/35" : "text-ink-500",
            )}
          >
            :
          </span>
          <span
            key={running ? timer.seconds : "static"}
            className={cn(
              "text-[clamp(4.5rem,15vw,9rem)] font-medium leading-[0.85] tracking-tighter",
              running && "tick",
              running || paused ? "text-cream-50" : "text-ink-500",
            )}
          >
            {secondsPart}
          </span>
        </div>

        <p className="label mt-4 h-4">
          {running ? (
            <span className="text-ember-400">Focusing</span>
          ) : paused ? (
            "Paused"
          ) : ready ? (
            "Ready"
          ) : (
            ""
          )}
        </p>

        {/* ---------------- controls ---------------- */}
        <div className="mt-8 flex items-center gap-3">
          {phase === "idle" && (
            <Button
              variant="primary"
              size="lg"
              onClick={() => void startTimer()}
              disabled={blockedByOtherGoal || !ready}
              className="min-w-[9.5rem]"
            >
              <Play size={16} strokeWidth={2.5} />
              Start focus
            </Button>
          )}
          {running && (
            <Button
              variant="outline"
              size="lg"
              onClick={() => void pauseTimer()}
              className="min-w-[7rem]"
            >
              <Pause size={16} />
              Pause
            </Button>
          )}
          {paused && (
            <Button
              variant="primary"
              size="lg"
              onClick={() => void resumeTimer()}
              className="min-w-[7rem]"
            >
              <Play size={16} strokeWidth={2.5} />
              Resume
            </Button>
          )}
          {phase !== "idle" && (
            <Button variant="default" size="lg" onClick={() => void handleStop()}>
              <Square size={14} strokeWidth={3} />
              Finish
            </Button>
          )}
        </div>

        {phase === "idle" && ready && !blockedByOtherGoal && (
          <p className="mt-3 text-xs text-cream-600">
            or press{" "}
            <kbd className="rounded border border-ink-600 bg-ink-850 px-1.5 py-0.5 font-mono text-[0.7rem]">
              Space
            </kbd>
          </p>
        )}

        <div className="mt-6 w-full max-w-lg space-y-3">
          {blockedByOtherGoal && (
            <Alert tone="warn">
              A session is already running for another goal.{" "}
              <Link href={`/goal/${timer.activeGoalId}`} className="underline underline-offset-4">
                Open it
              </Link>{" "}
              to finish it first.
            </Alert>
          )}
          {timer.warning && !pending && <Alert tone="warn">{timer.warning.message}</Alert>}
          {message && <Alert tone="success">{message}</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      </section>

      <div className="seam" />

      {/* ---------------- session ledger ---------------- */}
      <section className="py-8">
        <h2 className="font-display text-2xl text-cream-50">Sessions</h2>

        {sessions === undefined ? (
          <p className="label mt-4">Loading</p>
        ) : sessions.length === 0 ? (
          <p className="mt-3 max-w-md text-sm leading-relaxed text-cream-400">
            Nothing logged for this goal yet. Start the timer above, or add a past session from the
            Today screen.
          </p>
        ) : (
          <Panel className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[540px] text-sm">
              <caption className="sr-only">
                Logged sessions. Duration and notes are editable.
              </caption>
              <thead>
                <tr className="border-b border-ink-700">
                  <th scope="col" className="label px-4 py-3 text-left font-medium">
                    Date
                  </th>
                  <th scope="col" className="label px-4 py-3 text-left font-medium">
                    Minutes
                  </th>
                  <th scope="col" className="label px-4 py-3 text-left font-medium">
                    Note
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 40).map((session) => (
                  <tr
                    key={session.log_id}
                    className="border-b border-ink-800 transition-colors last:border-0 hover:bg-ink-850/60"
                  >
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className="num text-cream-200">{session.local_date}</span>
                      {session.source === "manual" && (
                        <span className="ml-2 rounded border border-ink-600 px-1.5 py-0.5 text-[0.65rem] text-cream-600">
                          manual
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        aria-label={`Minutes for the session on ${session.local_date}`}
                        className="num h-8 w-20 px-2"
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
                      {/* The exact duration, because a 40-second session rounds
                          to "0" minutes and that reads as lost data. */}
                      <span className="num shrink-0 text-xs text-cream-600">
                        {formatTotal(session.duration_seconds)}
                      </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Input
                        aria-label={`Note for the session on ${session.local_date}`}
                        placeholder="—"
                        className="h-8 border-transparent bg-transparent px-2 hover:border-ink-700"
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
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Delete this session"
                        aria-label={`Delete the session on ${session.local_date}`}
                        className="hover:text-danger"
                        onClick={() => {
                          void (async () => {
                            await deleteSession(session.log_id);
                            notifyMutation();
                          })();
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </section>

      {/* ---------------- finish dialog ---------------- */}
      <Dialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          // Closing returns to a paused timer rather than discarding — the old
          // modal had no exit that kept the session alive.
          if (!open) setPending(undefined);
        }}
      >
        {pending && (
          <DialogContent
            title="Log this session?"
            description={
              <>
                You focused for{" "}
                <span className="num text-cream-50">{formatTotal(pending.seconds)}</span>
                {pending.seconds < 60 && " — under a minute"}.
              </>
            }
          >
            <div className="space-y-5">
              <Field label="Note" htmlFor="session-note" hint="Optional. What did you work on?">
                <Input
                  id="session-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="e.g. chapter 3 rewrite"
                  maxLength={2000}
                />
              </Field>

              <Button
                variant="primary"
                className="w-full"
                onClick={() => void commit(pending.seconds)}
              >
                Log {formatTotal(pending.seconds)}
              </Button>

              <div className="seam" />

              <Field
                label="Or log a different duration"
                htmlFor="adjust"
                hint="You can enter more than the recorded time — useful if this tab was in the background and under-counted."
              >
                <div className="flex gap-2">
                  <Input
                    id="adjust"
                    type="number"
                    min={0}
                    max={MAX_SESSION_SECONDS / 60}
                    value={adjustMinutes}
                    onChange={(event) => setAdjustMinutes(event.target.value)}
                    className={cn("num", adjustInvalid && "border-danger")}
                    aria-invalid={adjustInvalid}
                  />
                  <Button
                    variant="default"
                    disabled={adjustInvalid}
                    onClick={() => void commit(adjustedSeconds)}
                    className="shrink-0"
                  >
                    Log {formatTotal(adjustedSeconds)}
                  </Button>
                </div>
              </Field>

              <div className="seam" />

              <div className="flex items-center justify-between gap-3">
                <Button variant="ghost" size="sm" onClick={() => setPending(undefined)}>
                  Keep timing
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      await discardTimer();
                      setPending(undefined);
                      setNote("");
                      setMessage("Session discarded.");
                    })();
                  }}
                >
                  <Trash2 size={13} />
                  Discard
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
