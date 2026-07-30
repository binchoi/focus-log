/**
 * Install state for the PWA.
 *
 * Three things make this fiddlier than it looks:
 *
 *  1. `beforeinstallprompt` fires once, shortly after load. If nothing is
 *     listening at that moment the event is gone — so the listener is registered
 *     at module scope rather than inside a component that might mount later.
 *  2. Each event instance can only be `prompt()`ed once. After the user answers,
 *     the browser must fire a fresh one before we can ask again.
 *  3. It is Chromium-only. Safari (iOS and macOS) and Firefox never fire it, so a
 *     button alone would be a dead end on those platforms; they need the manual
 *     steps instead.
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface InstallState {
  /** A captured prompt event is available, so we can offer a real button. */
  canPrompt: boolean;
  /** The app is running as an installed app right now. */
  standalone: boolean;
  /** The browser reported a successful install this session. */
  justInstalled: boolean;
  /**
   * Which browser family we are in. Part of the snapshot rather than read in an
   * effect: the user agent does not exist during SSR, so the server snapshot is
   * "unknown" and React swaps in the real value on hydration. Reading it in an
   * effect instead would mean a setState during mount, and reading it during
   * render would produce markup that differs between server and client.
   */
  platform: Platform;
  /** The user closed the opportunistic nudge; Settings is then the only route. */
  dismissed: boolean;
}

const DISMISSED_KEY = "focus-log.install_dismissed";

let deferred: BeforeInstallPromptEvent | undefined;
let justInstalled = false;
let platform: Platform = "unknown";
let dismissed = false;
const listeners = new Set<() => void>();

/** Cached so useSyncExternalStore sees a stable identity between changes. */
let snapshot: InstallState = {
  canPrompt: false,
  standalone: false,
  justInstalled: false,
  platform: "unknown",
  dismissed: true,
};

/**
 * What the server renders. `dismissed: true` so the nudge is never part of the
 * server markup — it can only appear after the client has both captured an event
 * and checked localStorage.
 */
const SERVER_SNAPSHOT: InstallState = {
  canPrompt: false,
  standalone: false,
  justInstalled: false,
  platform: "unknown",
  dismissed: true,
};

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS Safari predates the display-mode media query and uses its own flag.
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return window.matchMedia?.("(display-mode: standalone)").matches === true || iosStandalone;
}

function recompute(): void {
  const next: InstallState = {
    canPrompt: deferred !== undefined,
    standalone: isStandalone(),
    justInstalled,
    platform,
    dismissed,
  };
  if (
    next.canPrompt === snapshot.canPrompt &&
    next.standalone === snapshot.standalone &&
    next.justInstalled === snapshot.justInstalled &&
    next.platform === snapshot.platform &&
    next.dismissed === snapshot.dismissed
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  platform = detectPlatform(navigator.userAgent);
  try {
    dismissed = localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // Storage can be blocked; treat that as "not dismissed".
    dismissed = false;
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    // Suppress the browser's own mini-infobar so our UI owns the moment.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    recompute();
  });

  window.addEventListener("appinstalled", () => {
    deferred = undefined;
    justInstalled = true;
    recompute();
  });

  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", recompute);

  recompute();
}

export function subscribeToInstallState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getInstallState(): InstallState {
  return snapshot;
}

export function getServerInstallState(): InstallState {
  return SERVER_SNAPSHOT;
}

/** Hides the opportunistic nudge for good. Settings remains available. */
export function dismissInstallNudge(): void {
  dismissed = true;
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Non-fatal: the nudge just reappears next session.
  }
  recompute();
}

export type PromptOutcome = "accepted" | "dismissed" | "unavailable";

/**
 * Shows the browser's install dialog.
 *
 * The captured event is discarded either way, because it cannot be reused; the
 * browser fires a new one if the app is still installable.
 */
export async function promptInstall(): Promise<PromptOutcome> {
  const event = deferred;
  if (!event) return "unavailable";
  deferred = undefined;
  recompute();

  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return "unavailable";
  }
}

// ---------------------------------------------------------------------------
// Manual instructions, for browsers that never fire the event
// ---------------------------------------------------------------------------

export type Platform = "ios" | "macos-safari" | "firefox" | "chromium" | "unknown";

/** Pure so it can be tested against real user-agent strings. */
export function detectPlatform(userAgent: string): Platform {
  const ua = userAgent.toLowerCase();
  // iPadOS 13+ reports a Mac UA, so touch support is the practical tell.
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/firefox|fxios/.test(ua)) return "firefox";
  // Chrome, Edge and friends all include "safari" in their UA, so exclude them.
  if (/safari/.test(ua) && !/chrome|chromium|crios|edg|opr/.test(ua)) return "macos-safari";
  if (/chrome|chromium|crios|edg|opr/.test(ua)) return "chromium";
  return "unknown";
}

export interface InstallGuidance {
  /** Whether to render a working install button. */
  showButton: boolean;
  heading: string;
  /** Manual steps, when there is no button to offer. */
  steps: string[];
  /** Set when installing is not possible in this browser at all. */
  unsupported?: string;
}

export function installGuidance(state: InstallState, platform: Platform): InstallGuidance {
  if (state.standalone) {
    return {
      showButton: false,
      heading: "Installed",
      steps: [],
    };
  }

  if (state.justInstalled) {
    return {
      showButton: false,
      heading: "Installed",
      steps: ["Open Focus Log from your home screen, dock or app launcher."],
    };
  }

  if (state.canPrompt) {
    return { showButton: true, heading: "Install Focus Log", steps: [] };
  }

  switch (platform) {
    case "ios":
      return {
        showButton: false,
        heading: "Add to your Home Screen",
        steps: [
          "Tap the Share button at the bottom of Safari.",
          "Scroll down and tap “Add to Home Screen”.",
          "Tap “Add”.",
        ],
      };
    case "macos-safari":
      return {
        showButton: false,
        heading: "Add to your Dock",
        steps: [
          "In Safari’s menu bar, choose File → Add to Dock.",
          "Confirm the name, then click Add.",
        ],
      };
    case "firefox":
      return {
        showButton: false,
        heading: "Install Focus Log",
        steps: [],
        unsupported:
          "Firefox on desktop cannot install web apps. Chrome, Edge or Safari can — or just bookmark this page; it works offline either way.",
      };
    default:
      return {
        showButton: false,
        heading: "Install Focus Log",
        steps: [
          "Look for an install icon in your browser’s address bar.",
          "Or open the browser menu and choose “Install” or “Add to Home Screen”.",
        ],
      };
  }
}
