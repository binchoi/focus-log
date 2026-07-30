import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the install *store* (the pure guidance logic lives in install.test.ts).
 *
 * The module registers its listeners at import time, guarded on `typeof window`,
 * so each case stubs the globals first and then imports a fresh copy via
 * resetModules. Importing once at the top would capture a windowless module and
 * none of the browser paths would ever run.
 */

interface FakeWindow {
  listeners: Map<string, ((event: unknown) => void)[]>;
  fire: (type: string, event?: unknown) => void;
  standaloneMatches: boolean;
}

function stubBrowser(options: { standalone?: boolean; dismissed?: boolean; ios?: boolean; ua?: string } = {}) {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const store = new Map<string, string>();
  if (options.dismissed) store.set("focus-log.install_dismissed", "1");

  const mediaListeners: (() => void)[] = [];
  const fake: FakeWindow = {
    listeners,
    standaloneMatches: options.standalone ?? false,
    fire(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event ?? { type });
    },
  };

  const win = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: () => {},
    matchMedia: (query: string) => ({
      media: query,
      get matches() {
        return query.includes("display-mode: standalone") ? fake.standaloneMatches : false;
      },
      addEventListener: (_: string, fn: () => void) => void mediaListeners.push(fn),
      removeEventListener: () => {},
    }),
    navigator: { standalone: options.ios ?? false },
  };

  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", {
    userAgent: options.ua ?? "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
    standalone: options.ios ?? false,
  });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });

  return { ...fake, storage: store, notifyMediaChange: () => mediaListeners.forEach((fn) => fn()) };
}

async function freshModule() {
  vi.resetModules();
  return import("./install");
}

/** A `beforeinstallprompt` stand-in that records prompt() calls. */
function promptEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const calls = { prompt: 0, preventDefault: 0 };
  return {
    calls,
    event: {
      preventDefault: () => void (calls.preventDefault += 1),
      prompt: () => {
        calls.prompt += 1;
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome, platform: "web" }),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("capturing the install event", () => {
  it("suppresses the browser's own infobar and exposes canPrompt", async () => {
    const browser = stubBrowser();
    const mod = await freshModule();
    expect(mod.getInstallState().canPrompt).toBe(false);

    const { event, calls } = promptEvent();
    browser.fire("beforeinstallprompt", event);

    // preventDefault is what stops Chrome showing its mini-infobar alongside ours.
    expect(calls.preventDefault).toBe(1);
    expect(mod.getInstallState().canPrompt).toBe(true);
  });

  it("notifies subscribers when the event arrives", async () => {
    const browser = stubBrowser();
    const mod = await freshModule();
    let notifications = 0;
    mod.subscribeToInstallState(() => void (notifications += 1));

    browser.fire("beforeinstallprompt", promptEvent().event);
    expect(notifications).toBe(1);
  });

  it("stops notifying after unsubscribe", async () => {
    const browser = stubBrowser();
    const mod = await freshModule();
    let notifications = 0;
    mod.subscribeToInstallState(() => void (notifications += 1))();

    browser.fire("beforeinstallprompt", promptEvent().event);
    expect(notifications).toBe(0);
  });

  it("returns a stable snapshot identity when nothing changed", async () => {
    const browser = stubBrowser();
    const mod = await freshModule();
    const first = mod.getInstallState();

    // A media change that flips nothing must not produce a new object, or
    // useSyncExternalStore would re-render on every notification.
    browser.notifyMediaChange();
    expect(mod.getInstallState()).toBe(first);
  });
});

describe("promptInstall", () => {
  it("invokes the browser dialog and reports the outcome", async () => {
    const browser = stubBrowser();
    const mod = await freshModule();
    const { event, calls } = promptEvent("accepted");
    browser.fire("beforeinstallprompt", event);

    await expect(mod.promptInstall()).resolves.toBe("accepted");
    expect(calls.prompt).toBe(1);
  });

  it("reports a decline", async () => {
    const browser = stubBrowser();
    const mod = await freshModule();
    browser.fire("beforeinstallprompt", promptEvent("dismissed").event);
    await expect(mod.promptInstall()).resolves.toBe("dismissed");
  });

  it("consumes the event, because it cannot be prompted twice", async () => {
    const browser = stubBrowser();
    const mod = await freshModule();
    browser.fire("beforeinstallprompt", promptEvent().event);

    await mod.promptInstall();
    expect(mod.getInstallState().canPrompt).toBe(false);
    // A second attempt must not silently pretend to work.
    await expect(mod.promptInstall()).resolves.toBe("unavailable");
  });

  it("is unavailable when no event was ever captured", async () => {
    stubBrowser();
    const mod = await freshModule();
    await expect(mod.promptInstall()).resolves.toBe("unavailable");
  });

  it("reports unavailable rather than throwing if the browser rejects", async () => {
    const browser = stubBrowser();
    const mod = await freshModule();
    browser.fire("beforeinstallprompt", {
      preventDefault: () => {},
      prompt: () => Promise.reject(new Error("not allowed")),
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
    });
    await expect(mod.promptInstall()).resolves.toBe("unavailable");
  });
});

describe("appinstalled", () => {
  it("records the install and drops the stale event", async () => {
    const browser = stubBrowser();
    const mod = await freshModule();
    browser.fire("beforeinstallprompt", promptEvent().event);
    expect(mod.getInstallState().canPrompt).toBe(true);

    browser.fire("appinstalled");
    const state = mod.getInstallState();
    expect(state.justInstalled).toBe(true);
    expect(state.canPrompt).toBe(false);
  });
});

describe("standalone detection", () => {
  it("detects display-mode: standalone", async () => {
    stubBrowser({ standalone: true });
    const mod = await freshModule();
    expect(mod.isStandalone()).toBe(true);
    expect(mod.getInstallState().standalone).toBe(true);
  });

  it("detects iOS Safari's own navigator.standalone flag", async () => {
    // iOS predates the media query, so this is the only signal there.
    stubBrowser({ ios: true });
    const mod = await freshModule();
    expect(mod.isStandalone()).toBe(true);
  });

  it("is false in an ordinary browser tab", async () => {
    stubBrowser();
    const mod = await freshModule();
    expect(mod.isStandalone()).toBe(false);
  });
});

describe("dismissing the nudge", () => {
  it("persists so it does not reappear next session", async () => {
    const browser = stubBrowser();
    const mod = await freshModule();
    mod.dismissInstallNudge();

    expect(mod.getInstallState().dismissed).toBe(true);
    expect(browser.storage.get("focus-log.install_dismissed")).toBe("1");
  });

  it("reads the stored flag on load", async () => {
    stubBrowser({ dismissed: true });
    const mod = await freshModule();
    expect(mod.getInstallState().dismissed).toBe(true);
  });

  it("treats blocked storage as not dismissed rather than crashing", async () => {
    stubBrowser();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    });
    const mod = await freshModule();
    expect(mod.getInstallState().dismissed).toBe(false);
    expect(() => mod.dismissInstallNudge()).not.toThrow();
  });
});

describe("server rendering", () => {
  it("reports a neutral state with the nudge suppressed", async () => {
    // window is absent, so no listeners are registered and nothing is read.
    const mod = await freshModule();
    const server = mod.getServerInstallState();
    expect(server).toMatchObject({
      canPrompt: false,
      standalone: false,
      justInstalled: false,
      platform: "unknown",
      // True so the nudge can never be part of server markup and then vanish.
      dismissed: true,
    });
    expect(mod.isStandalone()).toBe(false);
  });
});
