import { expect, test } from "@playwright/test";
import { FakeSheet, boot, createGoal } from "./helpers";

/**
 * The real acceptance test for the cross-device timer: two independent browser
 * contexts (two devices) share ONE spreadsheet. A timer started on device A must
 * be visible on device B, stoppable from B, and collapse to exactly one logged
 * session — the whole point of the feature.
 */
test.describe("cross-device timer (v2 sheet)", () => {
  test("start on one device, stop from another → one session, no double count", async ({
    browser,
  }) => {
    const sheet = new FakeSheet({ v2: true });

    const deviceA = await browser.newContext();
    const deviceB = await browser.newContext();
    await sheet.install(deviceA);
    await sheet.install(deviceB);
    const a = await deviceA.newPage();
    const b = await deviceB.newPage();

    // --- Device A: create a goal and start a focus timer ---
    await boot(a);
    await createGoal(a, "Deep work");
    await a.goto("/");
    await a.locator('a[href^="/goal/"]:not([href$="/stats"])').first().click();
    await a.getByRole("button", { name: /start focus/i }).click();

    // A publishes its running timer to the shared sheet.
    await expect.poll(() => sheet.liveActive().length, { timeout: 20_000 }).toBe(1);
    const sharedLogId = sheet.liveActive()[0]!.log_id;

    // --- Device B: boots after A published, and adopts the running timer ---
    await boot(b);
    // The global session strip shows a session B never started.
    await expect(b.getByText(/Focusing/).first()).toBeVisible({ timeout: 20_000 });

    // --- Device B stops it ---
    await b.getByRole("link", { name: /^open$/i }).click();
    await expect(b.getByRole("button", { name: /finish/i })).toBeVisible({ timeout: 15_000 });
    await b.getByRole("button", { name: /finish/i }).click();
    const dialog = b.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Log /i }).first().click();

    // Exactly one session, under the id minted at start on A — no double count.
    await expect.poll(() => sheet.liveSessions().length, { timeout: 20_000 }).toBe(1);
    expect(sheet.liveSessions()[0]!.log_id).toBe(sharedLogId);
    // The shared timer is tombstoned, so no device shows it running anymore.
    await expect.poll(() => sheet.liveActive().length, { timeout: 20_000 }).toBe(0);

    // --- Device A: on its next sync the timer clears (stopped elsewhere) ---
    // Checked on the home screen, where "Focusing" appears only in the running-
    // session strip (the goal page has an unrelated "Focusing on <goal>" label).
    await a.goto("/");
    await expect(a.getByText(/Focusing/)).toHaveCount(0, { timeout: 20_000 });

    await deviceA.close();
    await deviceB.close();
  });
});
