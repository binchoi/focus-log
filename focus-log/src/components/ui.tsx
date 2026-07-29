"use client";

/**
 * UI primitives.
 *
 * Radix supplies the behaviour that is genuinely hard to get right — focus
 * traps, Escape handling, ARIA wiring, scroll locking — which is what fixes the
 * accessibility cluster found in exploration (the old modal had no role, no
 * focus trap, no Escape, and left the background reachable by Tab).
 *
 * The styling is hand-written rather than taken from a component library's
 * default theme, because the default themes are the generic look this design is
 * deliberately avoiding.
 */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { forwardRef, type ComponentProps, type ReactNode } from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

const button = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap select-none",
    "font-medium rounded-lg border transition-all duration-200",
    "[transition-timing-function:var(--ease-instrument)]",
    "active:translate-y-px",
    "disabled:opacity-35 disabled:pointer-events-none",
  ],
  {
    variants: {
      variant: {
        /* Ember is reserved for starting/continuing focus — the one action the
           app exists for. Using it anywhere else would dilute it. */
        primary: [
          "bg-ember-500 text-ink-950 border-ember-600 font-semibold",
          "shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_6px_20px_-8px_var(--color-ember-500)]",
          "hover:bg-ember-400 hover:shadow-[0_1px_0_rgba(255,255,255,0.3)_inset,0_10px_28px_-8px_var(--color-ember-500)]",
        ],
        default: [
          "bg-ink-800 text-cream-200 border-ink-600",
          "shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]",
          "hover:bg-ink-700 hover:text-cream-50 hover:border-ink-500",
        ],
        ghost: "border-transparent text-cream-400 hover:text-cream-50 hover:bg-ink-800",
        danger: "bg-transparent text-danger border-danger/35 hover:bg-danger/10 hover:border-danger/60",
        outline: "bg-transparent text-cream-200 border-ink-600 hover:border-ink-500 hover:bg-ink-850",
      },
      size: {
        sm: "h-8 px-3 text-[0.8125rem]",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-6 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends ComponentProps<"button">,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, ...props },
  ref,
) {
  return <button ref={ref} className={cn(button({ variant, size }), className)} {...props} />;
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-10 w-full rounded-lg border border-ink-700 bg-ink-950/60 px-3 text-sm text-cream-50",
        "placeholder:text-cream-600 transition-colors duration-200",
        "hover:border-ink-600 focus:border-ember-500 focus:outline-none",
        "focus:ring-2 focus:ring-ember-500/20",
        className,
      )}
      {...props}
    />
  );
});

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="label block">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-cream-600">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function Panel({
  className,
  interactive,
  ...props
}: ComponentProps<"div"> & { interactive?: boolean }) {
  return <div className={cn("panel", interactive && "panel-hover", className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  children,
  className,
  title,
  description,
  hideClose,
}: {
  children: ReactNode;
  className?: string;
  title: string;
  description?: ReactNode;
  hideClose?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-50 bg-ink-950/80 backdrop-blur-sm",
          "data-[state=open]:animate-[rise_0.2s_ease-out]",
        )}
      />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2",
          "panel max-h-[85dvh] overflow-y-auto p-6",
          "data-[state=open]:animate-[rise_0.28s_var(--ease-instrument)]",
          className,
        )}
      >
        <DialogPrimitive.Title className="font-display text-2xl text-cream-50">
          {title}
        </DialogPrimitive.Title>
        {description && (
          <DialogPrimitive.Description className="mt-1.5 text-sm leading-relaxed text-cream-400">
            {description}
          </DialogPrimitive.Description>
        )}
        <div className="mt-5">{children}</div>
        {!hideClose && (
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute right-4 top-4 rounded-md p-1 text-cream-600 transition-colors hover:bg-ink-800 hover:text-cream-50"
          >
            <X size={16} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------
// Meter — a goal's progress toward its weekly target
// ---------------------------------------------------------------------------

export function Meter({
  value,
  max,
  color,
  label,
  className,
}: {
  value: number;
  max: number;
  color?: string;
  label: string;
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const complete = pct >= 100;
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-ink-800", className)}
    >
      <div
        className="h-full rounded-full transition-[width] duration-700"
        style={{
          width: `${pct}%`,
          background: complete
            ? `linear-gradient(90deg, ${color ?? "var(--color-ember-500)"}, var(--color-ember-300))`
            : (color ?? "var(--color-ember-500)"),
          boxShadow: complete ? `0 0 12px -2px ${color ?? "var(--color-ember-500)"}` : undefined,
          transitionTimingFunction: "var(--ease-instrument)",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat
// ---------------------------------------------------------------------------

export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="label">{label}</p>
      <p
        className={cn(
          "num mt-1.5 text-2xl leading-none tracking-tight",
          accent ? "text-ember-400" : "text-cream-50",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-cream-600">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline alert
// ---------------------------------------------------------------------------

const alertTone = {
  info: "border-ink-600 bg-ink-850 text-cream-200",
  warn: "border-warn/30 bg-warn/8 text-warn",
  danger: "border-danger/35 bg-danger/8 text-danger",
  success: "border-success/30 bg-success/8 text-success",
} as const;

export function Alert({
  tone = "info",
  children,
  className,
  role,
}: {
  tone?: keyof typeof alertTone;
  children: ReactNode;
  className?: string;
  role?: "alert" | "status";
}) {
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={cn(
        "rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed",
        alertTone[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Consistent colour for a goal, from the curated palette. */
export const GOAL_COLORS = [
  "#ff8c42",
  "#e8b04b",
  "#7fb069",
  "#4bab9c",
  "#6a8caf",
  "#9b7fb0",
  "#c4756b",
  "#8a9a5b",
] as const;

export function goalColor(goalId: string, fallback?: string): string {
  if (fallback && /^#[0-9a-fA-F]{6}$/.test(fallback) && fallback !== "#4caf50") return fallback;
  // Stable hash so a goal keeps its colour across devices without storing one.
  let hash = 0;
  for (let i = 0; i < goalId.length; i += 1) hash = (hash * 31 + goalId.charCodeAt(i)) | 0;
  return GOAL_COLORS[Math.abs(hash) % GOAL_COLORS.length]!;
}
