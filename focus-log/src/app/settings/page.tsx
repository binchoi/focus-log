"use client";

/**
 * Settings.
 *
 * Exists partly to fix a dead end found in exploration: once credentials were
 * saved, the old app had no route back to /credentials at all — the only
 * reference was an automatic redirect when credentials were *absent*, so
 * changing spreadsheet meant clearing localStorage by hand.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { clearCredentials } from "@lib/auth/credentials";
import { createGoal, deleteGoal, listGoals, updateGoal } from "@lib/store/repo";
import { formatTotal } from "@lib/time";
import { useApp } from "../providers";

export default function SettingsPage() {
  const router = useRouter();
  const { credentials, status, syncNow, notifyMutation, refreshCredentials } = useApp();

  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [confirmingReset, setConfirmingReset] = useState(false);

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
    <main className="settings-container">
      <nav className="navbar">
        <Link href="/">home</Link>
      </nav>

      <h1>Settings</h1>

      <section>
        <h2>Goals</h2>
        <p className="setup-help">
          Create, rename and archive goals here — no need to open the spreadsheet.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const title = newTitle.trim();
            if (!title) return;
            void run(async () => {
              await createGoal({ title, sort_order: goals.length });
              setNewTitle("");
            });
          }}
          className="settings-add"
        >
          <label htmlFor="new-goal" className="setup-label">
            New goal
          </label>
          <input
            id="new-goal"
            className="input-field"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="e.g. Deep work"
            maxLength={200}
          />
          <button type="submit" className="btn save-btn" disabled={!newTitle.trim()}>
            Add goal
          </button>
        </form>

        {goals.length === 0 ? (
          <p className="setup-help">No goals yet. Add one above to start logging focus time.</p>
        ) : (
          <ul className="settings-goals">
            {goals.map((goal) => (
              <li key={goal.goal_id}>
                <input
                  aria-label={`Title for ${goal.title}`}
                  className="input-field"
                  defaultValue={goal.title}
                  onBlur={(event) => {
                    const title = event.target.value.trim();
                    if (title && title !== goal.title) {
                      void run(() => updateGoal(goal.goal_id, { title }));
                    }
                  }}
                />
                <label>
                  Weekly target
                  <input
                    type="number"
                    min={0}
                    step={30}
                    aria-label={`Weekly target minutes for ${goal.title}`}
                    className="input-field settings-target"
                    defaultValue={goal.weekly_target_minutes}
                    onBlur={(event) => {
                      const minutes = Number(event.target.value);
                      if (Number.isFinite(minutes) && minutes >= 0 && minutes !== goal.weekly_target_minutes) {
                        void run(() => updateGoal(goal.goal_id, { weekly_target_minutes: minutes }));
                      }
                    }}
                  />
                  <span className="setup-help">{formatTotal(goal.weekly_target_minutes * 60)}/week</span>
                </label>
                <button
                  type="button"
                  className="btn discard-btn"
                  onClick={() => void run(() => deleteGoal(goal.goal_id))}
                >
                  Archive
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Sync</h2>
        <dl className="settings-facts">
          <dt>Spreadsheet</dt>
          <dd>
            {credentials ? (
              <a
                href={`https://docs.google.com/spreadsheets/d/${credentials.spreadsheetId}/edit`}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open in Google Sheets
              </a>
            ) : (
              "Not connected"
            )}
          </dd>
          <dt>Service account</dt>
          <dd>{credentials?.clientEmail ?? "—"}</dd>
          <dt>Queued changes</dt>
          <dd>{status.pending === 0 ? "All synced" : `${status.pending} waiting to upload`}</dd>
          <dt>Last synced</dt>
          <dd>{status.lastSyncedAt ? status.lastSyncedAt.toLocaleString() : "Never"}</dd>
        </dl>

        {status.offlineReason && (
          <p className="setup-warn" role="status">
            Offline — your changes are saved on this device and will upload automatically.
          </p>
        )}
        {status.error && (
          <p className="setup-error" role="alert">
            {status.error}
          </p>
        )}
        {status.malformedRows > 0 && (
          <p className="setup-warn" role="status">
            {status.malformedRows} row(s) in the spreadsheet could not be read and were skipped.
          </p>
        )}

        <button type="button" onClick={() => void syncNow()} disabled={status.running}>
          {status.running ? "Syncing…" : "Sync now"}
        </button>
      </section>

      <section>
        <h2>Connection</h2>
        <p className="setup-help">
          Change spreadsheet or replace your service account key. Your focus history stays on this
          device and in the spreadsheet.
        </p>
        <Link href="/setup" className="btn">
          Reconnect or change spreadsheet
        </Link>

        {!confirmingReset ? (
          <button type="button" className="btn discard-btn" onClick={() => setConfirmingReset(true)}>
            Disconnect
          </button>
        ) : (
          <div role="alertdialog" aria-label="Confirm disconnect" className="settings-danger">
            <p>
              Disconnect this browser? Your spreadsheet is untouched, but{" "}
              {status.pending > 0 ? (
                <strong>{status.pending} change(s) not yet uploaded will be lost.</strong>
              ) : (
                "this device will forget its credentials."
              )}
            </p>
            <button
              type="button"
              className="btn discard-btn"
              onClick={() => {
                void (async () => {
                  await clearCredentials();
                  await refreshCredentials();
                  router.push("/setup");
                })();
              }}
            >
              Yes, disconnect
            </button>
            <button type="button" onClick={() => setConfirmingReset(false)}>
              Cancel
            </button>
          </div>
        )}
      </section>

      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
