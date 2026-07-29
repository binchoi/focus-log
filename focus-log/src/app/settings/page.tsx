"use client";

/**
 * Settings.
 *
 * Exists partly to fix a dead end found in exploration: once credentials were
 * saved, the old app had no route back to /credentials at all, so changing
 * spreadsheet meant clearing localStorage by hand.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { clearCredentials } from "@lib/auth/credentials";
import { createGoal, deleteGoal, listGoals, updateGoal } from "@lib/store/repo";
import { formatTotal } from "@lib/time";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  Field,
  GOAL_COLORS,
  Input,
  Panel,
  cn,
  goalColor,
} from "@/components/ui";
import { SyncDetail } from "../sync-pill";
import { useApp } from "../providers";

export default function SettingsPage() {
  const router = useRouter();
  const { credentials, status, notifyMutation } = useApp();

  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const goals = useLiveQuery(() => listGoals(), [], undefined) ?? [];

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setError(undefined);
      try {
        await action();
        notifyMutation();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [notifyMutation],
  );

  return (
    <div className="mx-auto max-w-[820px] px-5 py-8 md:px-8 md:py-12">
      <header className="rise" style={{ "--i": 0 } as React.CSSProperties}>
        <p className="label">Configuration</p>
        <h1 className="mt-1.5 font-display text-4xl text-cream-50">Settings</h1>
      </header>

      {error && (
        <Alert tone="danger" className="mt-6">
          {error}
        </Alert>
      )}

      {/* ---------------- goals ---------------- */}
      <section className="rise mt-10" style={{ "--i": 1 } as React.CSSProperties}>
        <h2 className="font-display text-2xl text-cream-50">Goals</h2>
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-cream-400">
          Create, rename, retarget and archive goals here. None of this needs the spreadsheet.
        </p>

        <form
          className="mt-5 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const title = newTitle.trim();
            if (!title) return;
            void run(async () => {
              await createGoal({
                title,
                sort_order: goals.length,
                color: GOAL_COLORS[goals.length % GOAL_COLORS.length],
              });
              setNewTitle("");
            });
          }}
        >
          <Field label="New goal" htmlFor="new-goal" className="min-w-[16rem] flex-1">
            <Input
              id="new-goal"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="e.g. Deep work"
              maxLength={200}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={!newTitle.trim()}>
            <Plus size={15} />
            Add
          </Button>
        </form>

        {goals.length === 0 ? (
          <Panel className="mt-5 px-5 py-10 text-center">
            <p className="text-sm text-cream-400">
              No goals yet. Add one above to start logging focus time.
            </p>
          </Panel>
        ) : (
          <div className="mt-5">
            {/*
              Column headings appear once here rather than as a per-row <Field>
              label. Repeating "Title" and "Weekly target" down a list is noise,
              and — more practically — the per-row hint under the target input
              made that one column two lines taller than its neighbours, so
              nothing in the row could line up. Every row is now a single line of
              controls, aligned with items-center.
            */}
            <div className="hidden gap-3 px-4 pb-2 lg:grid lg:grid-cols-[0.625rem_1fr_13rem_11rem_2.25rem] lg:items-end">
              <span aria-hidden="true" />
              <span className="label">Goal</span>
              <span className="label">Weekly target</span>
              <span className="label">Colour</span>
              <span aria-hidden="true" />
            </div>

            <ul className="space-y-2.5">
              {goals.map((goal) => {
                const color = goalColor(goal.goal_id, goal.color);
                return (
                  <li key={goal.goal_id}>
                    <Panel className="flex flex-wrap items-center gap-3 p-4 lg:grid lg:grid-cols-[0.625rem_1fr_13rem_11rem_2.25rem]">
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: color }}
                      />

                      <Input
                        aria-label={`Title for ${goal.title}`}
                        defaultValue={goal.title}
                        maxLength={200}
                        className="min-w-[10rem] flex-1 lg:min-w-0"
                        onBlur={(event) => {
                          const title = event.target.value.trim();
                          if (title && title !== goal.title) {
                            void run(() => updateGoal(goal.goal_id, { title }));
                          }
                        }}
                      />

                      {/* Minutes field and its human-readable equivalent sit on
                          the same line, so this column is no taller than the
                          others. */}
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          step={30}
                          aria-label={`Weekly target minutes for ${goal.title}`}
                          className="num w-[5.5rem] shrink-0"
                          defaultValue={goal.weekly_target_minutes}
                          onBlur={(event) => {
                            const minutes = Number(event.target.value);
                            if (
                              Number.isFinite(minutes) &&
                              minutes >= 0 &&
                              minutes !== goal.weekly_target_minutes
                            ) {
                              void run(() =>
                                updateGoal(goal.goal_id, { weekly_target_minutes: minutes }),
                              );
                            }
                          }}
                        />
                        <span className="whitespace-nowrap text-xs text-cream-600">
                          {goal.weekly_target_minutes > 0
                            ? `${formatTotal(goal.weekly_target_minutes * 60)} per week`
                            : "no target"}
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        {GOAL_COLORS.map((swatch) => (
                          <button
                            key={swatch}
                            type="button"
                            aria-label={`Set ${goal.title} colour to ${swatch}`}
                            onClick={() =>
                              void run(() => updateGoal(goal.goal_id, { color: swatch }))
                            }
                            className={cn(
                              "h-4 w-4 rounded-full transition-transform duration-150 hover:scale-125",
                              color.toLowerCase() === swatch &&
                                "ring-2 ring-cream-200 ring-offset-2 ring-offset-ink-900",
                            )}
                            style={{ background: swatch }}
                          />
                        ))}
                      </div>

                      <Button
                        variant="ghost"
                        size="icon"
                        title={`Archive ${goal.title}`}
                        aria-label={`Archive ${goal.title}`}
                        className="shrink-0 hover:text-danger"
                        onClick={() => void run(() => deleteGoal(goal.goal_id))}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </Panel>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      {/* ---------------- sync ---------------- */}
      <section className="rise mt-12" style={{ "--i": 2 } as React.CSSProperties}>
        <h2 className="font-display text-2xl text-cream-50">Sync</h2>
        <Panel className="mt-4 p-5">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
            <dt className="label self-center">Spreadsheet</dt>
            <dd className="text-sm">
              {credentials ? (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${credentials.spreadsheetId}/edit`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 text-ember-400 underline-offset-4 hover:underline"
                >
                  Open in Google Sheets
                  <ExternalLink size={13} />
                </a>
              ) : (
                <span className="text-cream-600">Not connected</span>
              )}
            </dd>

            <dt className="label self-center">Service account</dt>
            <dd className="break-all text-sm text-cream-200">{credentials?.clientEmail ?? "—"}</dd>

            <dt className="label self-center">Queued</dt>
            <dd className="text-sm text-cream-200">
              {status.pending === 0 ? (
                "Everything uploaded"
              ) : (
                <>
                  <span className="num">{status.pending}</span> change
                  {status.pending === 1 ? "" : "s"} waiting
                </>
              )}
            </dd>

            <dt className="label self-center">Last synced</dt>
            <dd className="text-sm text-cream-200">
              {status.lastSyncedAt ? status.lastSyncedAt.toLocaleString() : "Never"}
            </dd>
          </dl>

          <div className="seam my-5" />
          <SyncDetail />
        </Panel>
      </section>

      {/* ---------------- connection ---------------- */}
      <section className="rise mt-12" style={{ "--i": 3 } as React.CSSProperties}>
        <h2 className="font-display text-2xl text-cream-50">Connection</h2>
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-cream-400">
          Your private key is stored so that it can sign requests but can never be read back out of
          this browser, and you are never asked to sign in again.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/setup">
            <Button variant="outline">Change spreadsheet or key</Button>
          </Link>
          <Button variant="danger" onClick={() => setConfirmDisconnect(true)}>
            Disconnect this browser
          </Button>
        </div>
      </section>

      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent
          title="Disconnect this browser?"
          description="Your spreadsheet is left completely untouched."
        >
          <div className="space-y-4">
            {status.pending > 0 && (
              <Alert tone="warn">
                <span className="num">{status.pending}</span> change
                {status.pending === 1 ? "" : "s"} have not reached the spreadsheet yet and will be
                lost. Sync first if you want to keep them.
              </Alert>
            )}
            <p className="text-sm leading-relaxed text-cream-400">
              This device will forget its credentials and stored sessions. You can reconnect any time
              with the same key.
            </p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                className="flex-1"
                onClick={() => {
                  void (async () => {
                    await clearCredentials();
                    router.push("/setup");
                  })();
                }}
              >
                Yes, disconnect
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
