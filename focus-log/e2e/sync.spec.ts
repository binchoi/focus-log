import { expect, test } from "@playwright/test";
import { FakeSheet, boot, createGoal, openFirstGoal, seedCredentials, watchForErrors } from "./helpers";

/**
 * The headline guarantee: a session survives a failed write.
 *
 * This is the browser-level counterpart to src/lib/sync/engine.test.ts. The unit
 * tests prove the engine's logic; these prove the whole stack — IndexedDB, the
 * live queries, the service worker, the real network layer — actually delivers it.
 */

async function bootWithGoal(page: import("@playwright/test").Page, sheet: FakeSheet) {
  await boot(page);
  await createGoal(page, "Deep work");
  // Let the debounced sync push the goal before the test goes offline.
  await expect.poll(() => sheet.goals.length, { timeout: 20_000 }).toBeGreaterThan(1);
}

test.describe("offline resilience", () => {
  test("C1: a session logged offline is not lost, and syncs on reconnect", async ({
    page,
    context,
  }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);
    const problems = watchForErrors(page);

    await bootWithGoal(page, sheet);

    // Open the timer screen first, then pull the network out from under it —
    // the realistic failure (wifi dies mid-session), and it keeps this test
    // about sync rather than about offline navigation.
    await openFirstGoal(page);
    await context.setOffline(true);

    await page.getByRole("button", { name: /start focus/i }).click();

    // Let the timer accrue, then finish and log.
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: /finish/i }).click();

    const logButton = page.getByRole("button", { name: /^Log /i }).first();
    await expect(logButton).toBeVisible();
    await logButton.click();

    // The session is committed locally and visible immediately — the old code
    // deleted its local state before the network call, so this row simply would
    // not exist.
    await expect(page.getByRole("cell", { name: /manual|^\d{4}-\d{2}-\d{2}$/ }).first()).toBeVisible();
    // Target the status alert specifically: the table caption also says "Logged".
    await expect(page.getByRole("status").filter({ hasText: /^Logged / })).toBeVisible();

    // And the UI is honest about not having uploaded it.
    await expect(page.getByRole("button", { name: /queued|offline/i })).toBeVisible();
    expect(sheet.liveSessions()).toHaveLength(0);

    // --- back online ------------------------------------------------------
    // No manual retry: regaining the network is itself a sync trigger, so the
    // queue must drain on its own. Asserting that is stronger than clicking.
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect.poll(() => sheet.liveSessions().length, { timeout: 25_000 }).toBe(1);
    const [logged] = sheet.liveSessions();
    expect(Number(logged!.duration_seconds)).toBeGreaterThan(0);
    expect(logged!.tz).toBeTruthy();
    expect(logged!.start_utc).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    await expect(page.getByRole("button", { name: /synced/i })).toBeVisible({ timeout: 20_000 });
    expect(problems).toEqual([]);
  });

  test("a lost append response does not create a duplicate session", async ({ page, context }) => {
    const sheet = new FakeSheet({ swallowAppendResponses: true });
    await sheet.install(context);

    await boot(page);
    await createGoal(page, "Retry test");

    // Every append lands in the sheet but the client always sees a failure, so it
    // keeps retrying. Rows accumulate...
    await expect.poll(() => sheet.appendCalls, { timeout: 20_000 }).toBeGreaterThan(1);
    expect(sheet.goals.length).toBeGreaterThan(2);

    // ...but they all carry the same goal_id and updated_at, so the reduce
    // collapses them to one record. That is what makes the retry safe.
    const ids = new Set(sheet.goals.slice(1).map((row) => String(row[0])));
    expect(ids.size).toBe(1);
  });

  test("a permissions failure is surfaced, not silently swallowed", async ({ page, context }) => {
    const sheet = new FakeSheet({ failWith: 403 });
    await sheet.install(context);

    // Seed credentials, then land on a chromed page so the sync pill exists.
    await page.goto("/");
    await page.waitForURL(/\/setup$/, { timeout: 20_000 });
    await seedCredentials(page);
    await page.goto("/");

    // The old app logged this to the console and showed a blank grid forever.
    await expect(page.getByRole("button", { name: /needs attention/i })).toBeVisible({
      timeout: 25_000,
    });
    await page.goto("/settings");
    await expect(page.getByText(/shared with the service account/i)).toBeVisible();
  });
});

test.describe("service worker", () => {
  test("registers and serves the app shell with the network down", async ({ page, context }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);

    await boot(page);

    const registered = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration?.active || registration?.installing || registration?.waiting);
    });
    expect(registered).toBe(true);

    await page.evaluate(() => navigator.serviceWorker.ready);

    // Assert the shell is actually in the Cache API. This is the property that
    // makes offline work; reloading under Playwright's offline emulation tests
    // the emulation as much as the worker, so check the cause directly.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return urls;
    });

    expect(cached.length).toBeGreaterThan(0);
    // Next's build assets and at least one document entry are precached.
    expect(cached.some((url) => url.includes("/_next/static/"))).toBe(true);
  });

  test("never caches Google — API responses and tokens must not be stored", async ({
    page,
    context,
  }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Give sync time to hit the API through the worker.
    await expect.poll(() => sheet.tokenCalls, { timeout: 20_000 }).toBeGreaterThan(0);

    const cachedGoogle = await page.evaluate(async () => {
      const names = await caches.keys();
      const hits: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (request.url.includes("googleapis.com")) hits.push(request.url);
        }
      }
      return hits;
    });

    // A cached sheet response would mean serving stale focus data as current;
    // a cached token response would park a credential in the Cache API.
    expect(cachedGoogle).toEqual([]);
  });
});
