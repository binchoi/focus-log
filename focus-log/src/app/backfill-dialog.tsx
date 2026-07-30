"use client";

/**
 * Manual entry for a session that happened away from the app.
 * Previously this meant typing a row into the spreadsheet by hand.
 */

import { useState } from "react";
import { logSession } from "@lib/store/repo";
import type { Goal } from "@lib/sheets/schema";
import { currentTimeZone, defaultBackfillStart, formatTotal, localDateOf } from "@lib/time";
import { Alert, Button, Dialog, DialogContent, Field, Input } from "@/components/ui";
import { useApp } from "./providers";

const PRESETS = [15, 25, 45, 60, 90];
const DEFAULT_MINUTES = 30;

export function BackfillDialog({
  goal,
  open,
  onOpenChange,
}: {
  goal: Goal;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { notifyMutation } = useApp();
  const timeZone = currentTimeZone();
  const today = localDateOf(new Date(), timeZone);

  // Derived from the clock, not a fixed hour. A constant default like "09:00" is
  // in the future for anyone opening this before 9am, so the form rejected its own
  // untouched values. Defaulting to a session that just finished is always valid
  // and matches the common case.
  const [initial] = useState(() => defaultBackfillStart(new Date(), timeZone, DEFAULT_MINUTES));
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [minutes, setMinutes] = useState(String(DEFAULT_MINUTES));
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
      notifyMutation();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add a past session"
        description={`Logging time to ${goal.title}.`}
      >
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" htmlFor="bf-date">
              <Input
                id="bf-date"
                type="date"
                value={date}
                max={today}
                onChange={(event) => setDate(event.target.value)}
                className="num"
              />
            </Field>
            <Field label="Started at" htmlFor="bf-time">
              <Input
                id="bf-time"
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                className="num"
              />
            </Field>
          </div>

          <Field
            label="Minutes focused"
            htmlFor="bf-minutes"
            hint={
              Number(minutes) > 0 ? `That's ${formatTotal(Number(minutes) * 60)}.` : undefined
            }
          >
            <Input
              id="bf-minutes"
              type="number"
              min={1}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              className="num"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setMinutes(String(preset))}
                  className="num rounded-md border border-ink-700 px-2 py-1 text-xs text-cream-400 transition-colors hover:border-ink-500 hover:text-cream-50"
                >
                  {preset}m
                </button>
              ))}
            </div>
          </Field>

          <Field label="Note" htmlFor="bf-note" hint="Optional.">
            <Input
              id="bf-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
            />
          </Field>

          {error && <Alert tone="danger">{error}</Alert>}

          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy} className="flex-1">
              {busy ? "Adding…" : "Add session"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
