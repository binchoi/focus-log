import { describe, expect, it } from "vitest";
import { detectPlatform, installGuidance, type InstallState } from "./install";

const state = (over: Partial<InstallState> = {}): InstallState => ({
  canPrompt: false,
  standalone: false,
  justInstalled: false,
  platform: "unknown",
  dismissed: false,
  ...over,
});

describe("detectPlatform", () => {
  it("identifies iOS Safari, which never fires beforeinstallprompt", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("ios");
    expect(
      detectPlatform(
        "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("ios");
  });

  it("identifies macOS Safari without mistaking Chrome for it", () => {
    // Every Chromium UA also contains "safari", which is the classic trap here.
    expect(
      detectPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      ),
    ).toBe("macos-safari");
    expect(
      detectPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      ),
    ).toBe("chromium");
  });

  it("identifies Chromium variants", () => {
    for (const ua of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1",
    ]) {
      // Chrome on iOS is still WebKit and still cannot install, but it reports as
      // iOS first, which is the guidance we want to show.
      expect(["chromium", "ios"]).toContain(detectPlatform(ua));
    }
  });

  it("identifies Firefox on desktop and Android", () => {
    expect(
      detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0"),
    ).toBe("firefox");
    expect(detectPlatform("Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0")).toBe(
      "firefox",
    );
  });

  it("falls back to unknown rather than guessing", () => {
    expect(detectPlatform("some-crawler/1.0")).toBe("unknown");
    expect(detectPlatform("")).toBe("unknown");
  });
});

describe("installGuidance", () => {
  it("offers a real button only when a prompt event was captured", () => {
    const guidance = installGuidance(state({ canPrompt: true }), "chromium");
    expect(guidance.showButton).toBe(true);
    expect(guidance.steps).toEqual([]);
  });

  it("reports the installed state when already running standalone", () => {
    const guidance = installGuidance(state({ standalone: true }), "chromium");
    expect(guidance.showButton).toBe(false);
    expect(guidance.heading).toBe("Installed");
  });

  it("standalone wins even if a stale prompt event is still held", () => {
    const guidance = installGuidance(state({ standalone: true, canPrompt: true }), "chromium");
    expect(guidance.showButton).toBe(false);
  });

  it("acknowledges an install that just completed", () => {
    const guidance = installGuidance(state({ justInstalled: true }), "chromium");
    expect(guidance.heading).toBe("Installed");
    expect(guidance.steps.join(" ")).toMatch(/home screen|dock/i);
  });

  it("gives iOS the Share-sheet steps, since it has no install event", () => {
    const guidance = installGuidance(state(), "ios");
    expect(guidance.showButton).toBe(false);
    expect(guidance.steps.join(" ")).toMatch(/Add to Home Screen/i);
  });

  it("gives macOS Safari the Add to Dock steps", () => {
    const guidance = installGuidance(state(), "macos-safari");
    expect(guidance.steps.join(" ")).toMatch(/Add to Dock/i);
  });

  it("says plainly that Firefox cannot install, instead of showing a dead button", () => {
    const guidance = installGuidance(state(), "firefox");
    expect(guidance.showButton).toBe(false);
    expect(guidance.unsupported).toMatch(/cannot install/i);
    // Still tells the user the app works offline regardless.
    expect(guidance.unsupported).toMatch(/offline/i);
  });

  it("falls back to generic address-bar guidance for an unrecognised browser", () => {
    const guidance = installGuidance(state(), "unknown");
    expect(guidance.showButton).toBe(false);
    expect(guidance.steps.length).toBeGreaterThan(0);
  });

  it("never offers a button without an event, on any platform", () => {
    for (const platform of ["ios", "macos-safari", "firefox", "chromium", "unknown"] as const) {
      expect(installGuidance(state(), platform).showButton).toBe(false);
    }
  });
});
