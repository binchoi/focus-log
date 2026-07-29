import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebouncedTrigger, installSyncTriggers } from "./triggers";

/** Minimal DOM stand-ins so the trigger wiring can be tested under Node. */
function stubBrowser({ visibility = "visible", online = true } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const record = (target: string, type: string, fn: () => void) => {
    const key = `${target}:${type}`;
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(fn);
  };
  const remove = (target: string, type: string, fn: () => void) => {
    listeners.get(`${target}:${type}`)?.delete(fn);
  };

  const state = { visibilityState: visibility };

  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: () => void) => record("window", type, fn),
    removeEventListener: (type: string, fn: () => void) => remove("window", type, fn),
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visibilityState;
    },
    addEventListener: (type: string, fn: () => void) => record("document", type, fn),
    removeEventListener: (type: string, fn: () => void) => remove("document", type, fn),
  });
  vi.stubGlobal("navigator", { onLine: online });

  return {
    state,
    fire(target: string, type: string) {
      for (const fn of listeners.get(`${target}:${type}`) ?? []) fn();
    },
    count(target: string, type: string) {
      return listeners.get(`${target}:${type}`)?.size ?? 0;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("installSyncTriggers", () => {
  it("fires a startup sync asynchronously, not inline", () => {
    vi.useFakeTimers();
    const browser = stubBrowser();
    const onTrigger = vi.fn();

    const teardown = installSyncTriggers({ onTrigger });
    // Must not have fired synchronously — doing so inside a React effect body
    // would be a synchronous setState during render.
    expect(onTrigger).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTrigger).toHaveBeenCalledWith("startup");
    teardown();
    void browser;
  });

  it("syncs when the network comes back", () => {
    vi.useFakeTimers();
    const browser = stubBrowser();
    const onTrigger = vi.fn();
    const teardown = installSyncTriggers({ onTrigger, immediate: false });

    browser.fire("window", "online");
    expect(onTrigger).toHaveBeenCalledWith("online");
    teardown();
  });

  it("syncs when the tab becomes visible, but not when it is hidden", () => {
    vi.useFakeTimers();
    const browser = stubBrowser();
    const onTrigger = vi.fn();
    const teardown = installSyncTriggers({ onTrigger, immediate: false });

    browser.state.visibilityState = "hidden";
    browser.fire("document", "visibilitychange");
    expect(onTrigger).not.toHaveBeenCalled();

    browser.state.visibilityState = "visible";
    browser.fire("document", "visibilitychange");
    expect(onTrigger).toHaveBeenCalledWith("visible");
    teardown();
  });

  it("polls while visible and online", () => {
    vi.useFakeTimers();
    stubBrowser();
    const onTrigger = vi.fn();
    const teardown = installSyncTriggers({ onTrigger, immediate: false, pollMs: 1000 });

    vi.advanceTimersByTime(3500);
    expect(onTrigger).toHaveBeenCalledTimes(3);
    expect(onTrigger).toHaveBeenLastCalledWith("poll");
    teardown();
  });

  it("does not poll a hidden tab, to avoid wasting Sheets quota", () => {
    vi.useFakeTimers();
    const browser = stubBrowser({ visibility: "hidden" });
    const onTrigger = vi.fn();
    const teardown = installSyncTriggers({ onTrigger, immediate: false, pollMs: 1000 });

    vi.advanceTimersByTime(5000);
    expect(onTrigger).not.toHaveBeenCalled();
    void browser;
    teardown();
  });

  it("does not poll while offline", () => {
    vi.useFakeTimers();
    stubBrowser({ online: false });
    const onTrigger = vi.fn();
    const teardown = installSyncTriggers({ onTrigger, immediate: false, pollMs: 1000 });

    vi.advanceTimersByTime(5000);
    expect(onTrigger).not.toHaveBeenCalled();
    teardown();
  });

  it("C5 regression: teardown removes every listener and timer", () => {
    // The old code created a setInterval with no cleanup at all, leaking it for
    // the lifetime of the page.
    vi.useFakeTimers();
    const browser = stubBrowser();
    const onTrigger = vi.fn();

    const teardown = installSyncTriggers({ onTrigger, immediate: false, pollMs: 1000 });
    expect(browser.count("window", "online")).toBe(1);
    expect(browser.count("document", "visibilitychange")).toBe(1);

    teardown();

    expect(browser.count("window", "online")).toBe(0);
    expect(browser.count("document", "visibilitychange")).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("suppresses a queued startup trigger if torn down first", () => {
    vi.useFakeTimers();
    stubBrowser();
    const onTrigger = vi.fn();
    installSyncTriggers({ onTrigger })();
    vi.advanceTimersByTime(100);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("is a harmless no-op during server rendering", () => {
    vi.stubGlobal("window", undefined);
    const onTrigger = vi.fn();
    expect(() => installSyncTriggers({ onTrigger })()).not.toThrow();
    expect(onTrigger).not.toHaveBeenCalled();
  });
});

describe("createDebouncedTrigger", () => {
  it("coalesces a burst of mutations into one sync", () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const trigger = createDebouncedTrigger(onTrigger, 2000);

    // Editing several sessions in quick succession should push once.
    for (let i = 0; i < 10; i += 1) {
      trigger.request("mutation");
      vi.advanceTimersByTime(100);
    }
    expect(onTrigger).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("fires again for a later, separate burst", () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const trigger = createDebouncedTrigger(onTrigger, 1000);

    trigger.request("a");
    vi.advanceTimersByTime(1500);
    trigger.request("b");
    vi.advanceTimersByTime(1500);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("cancel prevents a pending sync", () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const trigger = createDebouncedTrigger(onTrigger, 1000);

    trigger.request("mutation");
    trigger.cancel();
    vi.advanceTimersByTime(5000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("cancel is safe with nothing pending", () => {
    const trigger = createDebouncedTrigger(vi.fn(), 1000);
    expect(() => {
      trigger.cancel();
      trigger.cancel();
    }).not.toThrow();
  });
});
