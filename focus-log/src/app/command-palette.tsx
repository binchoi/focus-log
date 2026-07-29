"use client";

/**
 * Command palette (⌘K / Ctrl+K).
 *
 * The point is to start a session on any goal without navigating anywhere — the
 * fastest path from "I'm about to focus" to "the timer is running", which is the
 * interaction this app exists for.
 *
 * Implemented as an ARIA combobox over a listbox: Radix has no combobox
 * primitive, so the roles, `aria-activedescendant` and the roving selection are
 * wired by hand here. Focus containment comes from rendering inside a Radix
 * Dialog.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BarChart3, Gauge, Pause, Play, Plus, Search, Settings, Square } from "lucide-react";
import { listGoals } from "@lib/store/repo";
import { formatTotal } from "@lib/time";
import { timerStore } from "@lib/timer/store";
import { pause, phaseOf, resume, start as startSession } from "@lib/timer/engine";
import { Dialog, DialogContent, cn, goalColor } from "@/components/ui";
import { useApp } from "./providers";

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: "Focus" | "Go" | "Session";
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  colour?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const router = useRouter();
  const { connection } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const goals = useLiveQuery(() => listGoals(), [], undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const store = timerStore();
    const active = store.snapshot();
    const phase = phaseOf(active);
    const list: Command[] = [];

    // Session controls first when something is running — that is what you most
    // likely opened the palette for.
    if (active && phase !== "idle") {
      const activeGoal = goals?.find((g) => g.goal_id === active.goalId);
      list.push({
        id: "session-toggle",
        label: phase === "running" ? "Pause current session" : "Resume current session",
        hint: activeGoal?.title,
        group: "Session",
        icon: phase === "running" ? Pause : Play,
        run: async () => {
          const at = Date.now();
          await store.write(phase === "running" ? pause(active, at) : resume(active, at), at);
        },
      });
      list.push({
        id: "session-finish",
        label: "Finish and log session",
        hint: activeGoal?.title,
        group: "Session",
        icon: Square,
        run: () => router.push(`/goal/${active.goalId}`),
      });
    }

    for (const goal of goals ?? []) {
      const isActive = active?.goalId === goal.goal_id;
      list.push({
        id: `focus-${goal.goal_id}`,
        label: isActive ? `Open ${goal.title}` : `Focus on ${goal.title}`,
        hint: goal.weekly_target_minutes > 0
          ? `${formatTotal(goal.weekly_target_minutes * 60)}/week target`
          : undefined,
        group: "Focus",
        icon: Play,
        colour: goalColor(goal.goal_id, goal.color),
        run: async () => {
          // Refuse to start on top of another goal's session; send the user to
          // the goal screen instead, which explains why.
          if (active && phase !== "idle") {
            router.push(`/goal/${active.goalId}`);
            return;
          }
          const at = Date.now();
          await store.write(startSession(goal.goal_id, at), at);
          router.push(`/goal/${goal.goal_id}`);
        },
      });
      list.push({
        id: `stats-${goal.goal_id}`,
        label: `Insights for ${goal.title}`,
        group: "Go",
        icon: BarChart3,
        colour: goalColor(goal.goal_id, goal.color),
        run: () => router.push(`/goal/${goal.goal_id}/stats`),
      });
    }

    list.push(
      { id: "go-today", label: "Today", group: "Go", icon: Gauge, run: () => router.push("/") },
      { id: "go-stats", label: "Insights", group: "Go", icon: BarChart3, run: () => router.push("/stats") },
      { id: "go-settings", label: "Settings", group: "Go", icon: Settings, run: () => router.push("/settings") },
      { id: "go-new-goal", label: "Add a goal", group: "Go", icon: Plus, run: () => router.push("/settings") },
    );

    return list;
  }, [goals, router]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    // Subsequence match, so "dw" finds "Focus on Deep work".
    return commands.filter((command) => {
      const haystack = `${command.label} ${command.hint ?? ""}`.toLowerCase();
      let index = 0;
      for (const char of needle) {
        index = haystack.indexOf(char, index);
        if (index === -1) return false;
        index += 1;
      }
      return true;
    });
  }, [commands, query]);

  // Clamped at read time rather than corrected in an effect, so the list can
  // shrink without ever rendering an out-of-range selection.
  const cursorIndex = Math.min(cursor, Math.max(0, filtered.length - 1));

  const runAt = useCallback(
    (index: number) => {
      const command = filtered[index];
      if (!command) return;
      setOpen(false);
      setQuery("");
      void command.run();
    },
    [filtered],
  );

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((cursorIndex + 1) % Math.max(1, filtered.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((cursorIndex - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAt(cursorIndex);
    } else if (event.key === "Home") {
      event.preventDefault();
      setCursor(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setCursor(Math.max(0, filtered.length - 1));
    }
  }

  // Scroll the highlighted row into view without moving DOM focus off the input.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${cursorIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursorIndex]);

  if (connection !== "ready") return null;

  let lastGroup = "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
        else setCursor(0);
      }}
    >
      <DialogContent
        title="Command palette"
        className="top-[15%] max-w-lg translate-y-0 p-0"
        hideClose
      >
        {/* The visible label is the input's placeholder; the dialog title exists
            for screen readers, so hide it visually. */}
        <style>{`[role="dialog"] > h2 { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }`}</style>

        <div className="flex items-center gap-3 border-b border-ink-700 px-4">
          <Search size={16} className="shrink-0 text-cream-600" />
          {/* A palette that does not focus its input on open is unusable. */}
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={
              filtered[cursorIndex] ? `palette-${filtered[cursorIndex].id}` : undefined
            }
            aria-label="Search commands"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Start a session, jump somewhere…"
            className="h-12 w-full bg-transparent text-[0.95rem] text-cream-50 placeholder:text-cream-600 focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-ink-600 bg-ink-850 px-1.5 py-0.5 font-mono text-[0.65rem] text-cream-600">
            esc
          </kbd>
        </div>

        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-cream-600">
            Nothing matches “{query}”.
          </p>
        ) : (
          <ul
            id="palette-list"
            role="listbox"
            aria-label="Commands"
            ref={listRef}
            className="max-h-[min(24rem,55dvh)] overflow-y-auto p-2"
          >
            {filtered.map((command, index) => {
              const showGroup = command.group !== lastGroup;
              lastGroup = command.group;
              const selected = index === cursorIndex;

              return (
                <li key={command.id}>
                  {showGroup && (
                    <p className="label px-2 pb-1 pt-3 first:pt-1" aria-hidden="true">
                      {command.group}
                    </p>
                  )}
                  <div
                    id={`palette-${command.id}`}
                    role="option"
                    aria-selected={selected}
                    data-index={index}
                    onClick={() => runAt(index)}
                    onMouseEnter={() => setCursor(index)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors",
                      selected ? "bg-ink-800 text-cream-50" : "text-cream-200",
                    )}
                  >
                    <command.icon
                      size={15}
                      className={cn("shrink-0", selected ? "text-ember-400" : "text-cream-600")}
                    />
                    {command.colour && (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: command.colour }}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.hint && (
                      <span className="shrink-0 truncate text-xs text-cream-600">{command.hint}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Discoverability affordance for the rail. */
export function PaletteHint() {
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
        )
      }
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-2 text-xs text-cream-600 transition-colors hover:border-ink-600 hover:text-cream-400 md:justify-start md:px-2.5"
      title="Command palette"
    >
      <Search size={13} className="shrink-0" />
      <span className="hidden md:block">Search</span>
      <kbd className="ml-auto hidden font-mono text-[0.65rem] md:block">⌘K</kbd>
    </button>
  );
}
