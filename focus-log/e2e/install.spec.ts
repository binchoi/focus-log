import { expect, test } from "@playwright/test";
import { FakeSheet, boot } from "./helpers";

/**
 * Install flow.
 *
 * Headless Chromium does not fire `beforeinstallprompt` (it depends on install
 * criteria and engagement heuristics), so the button path is exercised by
 * dispatching the event the way the browser would. That is the honest way to
 * test it: the code under test only ever sees the event, so a faithful synthetic
 * one covers the same path.
 */

/** Dispatches a `beforeinstallprompt` that records whether prompt() was called. */
async function fireInstallPrompt(page: import("@playwright/test").Page, outcome = "accepted") {
  await page.evaluate((choice) => {
    const event = new Event("beforeinstallprompt") as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string; platform: string }>;
    };
    const win = window as unknown as { __promptCalls: number };
    win.__promptCalls = 0;
    event.prompt = () => {
      win.__promptCalls += 1;
      return Promise.resolve();
    };
    event.userChoice = Promise.resolve({ outcome: choice, platform: "web" });
    window.dispatchEvent(event);
  }, outcome);
}

test.describe("install", () => {
  test("Settings offers a working install button once the browser allows it", async ({
    page,
    context,
  }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);
    await page.goto("/settings");

    const section = page.getByRole("heading", { name: "Install", exact: true });
    await expect(section).toBeVisible();

    // Before any event, Chromium gets guidance rather than a dead button.
    await expect(page.getByRole("button", { name: /install focus log/i })).toBeHidden();
    await expect(page.getByText(/install icon in your browser/i)).toBeVisible();

    await fireInstallPrompt(page, "accepted");

    const button = page.getByRole("button", { name: /install focus log/i });
    await expect(button).toBeVisible();
    await button.click();

    // The browser's dialog was actually invoked.
    await expect.poll(() => page.evaluate(() => (window as never as { __promptCalls: number }).__promptCalls)).toBe(1);
  });

  test("declining leaves the section usable rather than dead-ending", async ({ page, context }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);
    await page.goto("/settings");

    await fireInstallPrompt(page, "dismissed");
    await page.getByRole("button", { name: /install focus log/i }).click();

    await expect(page.getByText(/not installed/i)).toBeVisible();
    // A prompt event cannot be reused, so the button correctly goes away until
    // the browser offers another one — the guidance takes its place.
    await expect(page.getByText(/install icon in your browser/i)).toBeVisible();
  });

  test("the section is reachable even after the pop-up nudge is dismissed forever", async ({
    page,
    context,
  }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);

    await fireInstallPrompt(page);
    const nudge = page.getByRole("button", { name: /^install$/i });
    await expect(nudge).toBeVisible();
    await page.getByRole("button", { name: /dismiss install prompt/i }).click();
    await expect(nudge).toBeHidden();

    // Dismissal persists across reloads...
    await page.reload();
    await fireInstallPrompt(page);
    await expect(page.getByRole("button", { name: /^install$/i })).toBeHidden();

    // ...but Settings still offers it. This is the whole reason the section exists.
    await page.goto("/settings");
    await fireInstallPrompt(page);
    await expect(page.getByRole("button", { name: /install focus log/i })).toBeVisible();
  });

  test("iOS is given Share-sheet steps, not a button it cannot honour", async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const sheet = new FakeSheet();
    await sheet.install(context);

    await boot(page);
    await page.goto("/settings");

    await expect(page.getByText(/Add to your Home Screen/i)).toBeVisible();
    await expect(page.getByText(/Add to Home Screen/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /install focus log/i })).toBeHidden();

    await context.close();
  });

  test("Firefox is told plainly that it cannot install", async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0",
    });
    const page = await context.newPage();
    const sheet = new FakeSheet();
    await sheet.install(context);

    await boot(page);
    await page.goto("/settings");

    await expect(page.getByText(/cannot install web apps/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /install focus log/i })).toBeHidden();

    await context.close();
  });

  test("running standalone reports installed instead of offering to install", async ({
    browser,
  }) => {
    // display-mode is not settable from Playwright, so stub matchMedia before any
    // app code runs — the store reads it at module scope.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = ((query: string) =>
        query.includes("display-mode: standalone")
          ? { matches: true, addEventListener() {}, removeEventListener() {}, media: query }
          : real(query)) as typeof window.matchMedia;
    });

    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);
    await page.goto("/settings");

    await expect(page.getByText(/running as an installed app/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /install focus log/i })).toBeHidden();

    await context.close();
  });
});
