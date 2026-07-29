"use client";

/**
 * App shell: a persistent left rail plus a live session strip.
 *
 * The rail replaces the old bare lowercase text links, and the session strip
 * exists because a running timer is global state — previously you could navigate
 * away and lose all sight of it.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Gauge, Settings, Timer as TimerIcon, Plug } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { timerStore } from "@lib/timer/store";
import { elapsedSeconds, phaseOf } from "@lib/timer/engine";
import { formatDuration } from "@lib/time";
import { listGoals } from "@lib/store/repo";
import { cn, goalColor } from "@/components/ui";
import { SyncPill } from "./sync-pill";
import { CommandPalette, PaletteHint } from "./command-palette";
import { PwaBits } from "./pwa";
import { useApp } from "./providers";

const NAV = [
  { href: "/", label: "Today", icon: Gauge },
  { href: "/stats", label: "Insights", icon: TimerIcon },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { connection } = useApp();

  // /setup is deliberately chromeless: you have no data yet, so a nav rail
  // pointing at empty screens is just noise.
  if (pathname === "/setup" || pathname === "/offline" || connection === "unconfigured") {
    return (
      <main className="min-h-dvh">
        {children}
        <PwaBits />
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh">
      <Rail pathname={pathname} />
      <div className="flex min-w-0 flex-1 flex-col">
        <ActiveSessionStrip />
        <main className="min-w-0 flex-1 pb-14">{children}</main>
      </div>
      <CommandPalette />
      <PwaBits />
    </div>
  );
}

function Rail({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Main"
      className="sticky top-0 z-30 flex h-dvh w-[68px] shrink-0 flex-col items-center gap-1 border-r border-ink-800 bg-ink-900/60 py-5 backdrop-blur-xl md:w-[200px] md:items-stretch md:px-3"
    >
      <Link
        href="/"
        className="mb-6 flex items-center gap-2.5 px-1.5 md:px-2"
        aria-label="Focus Log home"
      >
        {/* Filament mark: a ring with an ember core. */}
        <span className="relative grid h-8 w-8 shrink-0 place-items-center">
          <span className="absolute inset-0 rounded-full border border-ember-500/40" />
          <span className="h-2 w-2 rounded-full bg-ember-500 shadow-[0_0_10px_2px_var(--color-ember-500)]" />
        </span>
        <span className="hidden font-display text-lg leading-none text-cream-50 md:block">
          Focus&nbsp;Log
        </span>
      </Link>

      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm transition-colors duration-200 md:px-3",
              active ? "bg-ink-800 text-cream-50" : "text-cream-400 hover:bg-ink-850 hover:text-cream-200",
            )}
          >
            {/* Active marker on the rail edge, not a filled pill — quieter. */}
            <span
              className={cn(
                "absolute left-0 top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-r-full bg-ember-500 transition-opacity duration-200 md:-left-2",
                active ? "opacity-100" : "opacity-0",
              )}
            />
            <Icon size={17} strokeWidth={1.75} className="shrink-0" />
            <span className="hidden md:block">{label}</span>
          </Link>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-2 md:items-stretch">
        <PaletteHint />
        <SyncPill />
      </div>
    </nav>
  );
}

/**
 * Shows a running session from anywhere in the app, with a live elapsed time.
 * Uses the same wall-clock derivation as the timer screen, so it cannot drift.
 */
function ActiveSessionStrip() {
  const state = useSyncExternalStore(
    (onChange) => timerStore().subscribe(() => onChange()),
    () => timerStore().snapshot(),
    () => undefined,
  );
  const [now, setNow] = useState(() => Date.now());
  const goals = useLiveQuery(() => listGoals(), [], undefined);

  useEffect(() => {
    void timerStore().load();
  }, []);

  const phase = phaseOf(state);
  const running = phase === "running";

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (phase === "idle" || !state) return null;

  const goal = goals?.find((g) => g.goal_id === state.goalId);
  const seconds = elapsedSeconds(state, now);
  const color = goalColor(state.goalId, goal?.color);

  return (
    <div className="sticky top-0 z-20 border-b border-ink-800 bg-ink-900/85 backdrop-blur-xl">
      <div className="flex items-center gap-3 px-5 py-2.5 md:px-8">
        <span className="relative grid h-2.5 w-2.5 shrink-0 place-items-center">
          {running && (
            <span
              className="breathe absolute inset-0 rounded-full"
              style={{ background: color, filter: "blur(3px)" }}
            />
          )}
          <span className="relative h-2 w-2 rounded-full" style={{ background: color }} />
        </span>

        <span className="label !text-cream-400">{running ? "Focusing" : "Paused"}</span>

        <Link
          href={`/goal/${state.goalId}`}
          className="min-w-0 truncate text-sm text-cream-50 underline-offset-4 hover:underline"
        >
          {goal?.title ?? "Session"}
        </Link>

        <span className="num ml-auto text-sm tabular-nums text-cream-200">
          {formatDuration(seconds)}
        </span>

        <Link
          href={`/goal/${state.goalId}`}
          className="rounded-md border border-ink-600 px-2.5 py-1 text-xs text-cream-200 transition-colors hover:border-ink-500 hover:bg-ink-800"
        >
          Open
        </Link>
      </div>
    </div>
  );
}

/** Shown while credentials are still being read from IndexedDB. */
export function ShellLoading() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex items-center gap-3 text-cream-600">
        <Plug size={16} className="animate-pulse" />
        <span className="label">Connecting</span>
      </div>
    </div>
  );
}
