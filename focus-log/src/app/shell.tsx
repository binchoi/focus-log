"use client";

/**
 * App shell.
 *
 * Two chromes, one per reach: on a wide screen a persistent left rail (a
 * pointing device is precise, vertical space is cheap); on a phone a centred
 * top bar that slides away as you scroll (a thumb wants targets near the top,
 * vertical space is precious). A left rail on a phone shoved every screen off
 * to the right and ate a fifth of the width — so below `md` it is gone.
 *
 * The live session strip is common to both and never hides: a running timer is
 * global state, and previously you could navigate away and lose all sight of it.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Gauge, Search, Settings, Timer as TimerIcon, Plug } from "lucide-react";
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

/** Is this nav entry the current section? "/" only matches exactly. */
function isActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

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
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Rail pathname={pathname} />
      <TopBar pathname={pathname} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* One strip for both chromes, pinned to the top of the content column.
            On a phone that column is full width and the top bar above it is not
            sticky, so the strip is what stays put once the bar scrolls away. */}
        <div className="sticky top-0 z-20">
          <ActiveSessionStrip />
        </div>
        <main className="min-w-0 flex-1 pb-14">{children}</main>
      </div>
      <CommandPalette />
      <PwaBits />
    </div>
  );
}

/** The ember filament mark. Shared by both chromes. */
function Brand({ withWordmark = false }: { withWordmark?: boolean }) {
  return (
    <>
      <span className="relative grid h-8 w-8 shrink-0 place-items-center">
        <span className="absolute inset-0 rounded-full border border-ember-500/40" />
        <span className="h-2 w-2 rounded-full bg-ember-500 shadow-[0_0_10px_2px_var(--color-ember-500)]" />
      </span>
      {withWordmark && (
        <span className="hidden font-display text-lg leading-none text-cream-50 md:block">
          Focus&nbsp;Log
        </span>
      )}
    </>
  );
}

/**
 * Phone chrome (below `md`): a centred segmented nav under a slim utility row.
 *
 * The bar is *not* sticky — it scrolls away with the page, keeping the reading
 * area tall. (An auto-hiding sticky bar was tried and abandoned: collapsing a
 * sticky element changes document height, which near the scroll boundary nudges
 * scrollY, which re-fires the hide/show — an oscillation loop.) The session
 * strip, pinned at the top of the content column below, is what stays once this
 * bar scrolls off, so a running timer is never lost.
 */
function TopBar({ pathname }: { pathname: string }) {
  return (
    <div className="border-b border-ink-800/70 bg-ink-900/80 backdrop-blur-xl md:hidden">
      <div className="flex h-12 items-center justify-between px-4">
        <Link href="/" className="flex items-center" aria-label="Focus Log home">
          <Brand />
        </Link>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
              )
            }
            aria-label="Search"
            title="Search"
            className="grid h-9 w-9 place-items-center rounded-lg border border-ink-700 bg-ink-900/60 text-cream-400 transition-colors hover:border-ink-600 hover:text-cream-200"
          >
            <Search size={16} strokeWidth={1.75} />
          </button>
          <SyncPill compact />
        </div>
      </div>

      <nav aria-label="Main" className="flex justify-center px-4 pb-2.5">
        <div className="flex items-center gap-1 rounded-full border border-ink-700 bg-ink-950/50 p-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(href, pathname);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[0.8125rem] font-medium transition-colors duration-200",
                  active ? "bg-ink-800 text-cream-50" : "text-cream-400 hover:text-cream-200",
                )}
              >
                <Icon
                  size={15}
                  strokeWidth={1.75}
                  className={cn("shrink-0", active && "text-ember-400")}
                />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function Rail({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Main"
      className="sticky top-0 z-30 hidden h-dvh w-[68px] shrink-0 flex-col items-center gap-1 border-r border-ink-800 bg-ink-900/60 py-5 backdrop-blur-xl md:flex md:w-[200px] md:items-stretch md:px-3"
    >
      <Link
        href="/"
        className="mb-6 flex items-center gap-2.5 px-1.5 md:px-2"
        aria-label="Focus Log home"
      >
        <Brand withWordmark />
      </Link>

      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(href, pathname);
        return (
          <Link
            key={href}
            href={href}
            // The visible label is hidden below md, so without this the link is
            // an unlabelled icon for anyone using a screen reader on a phone.
            aria-label={label}
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
 *
 * Not sticky itself — the desktop shell pins it at the top of the content
 * column, the phone shell nests it in the top bar. Returns null when idle, so
 * either wrapper collapses to nothing.
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
    <div className="border-b border-ink-800 bg-ink-900/85 backdrop-blur-xl">
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
