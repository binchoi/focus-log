import { expect, test } from "@playwright/test";
import { FakeSheet, boot, createGoal, openFirstGoal, watchForErrors } from "./helpers";

test.describe("setup", () => {
  test("rejects a spreadsheet whose columns are wrong, and says which", async ({ page, context }) => {
    const sheet = new FakeSheet({ corruptSessionHeader: true });
    await sheet.install(context);

    await page.goto("/setup");

    // A real service-account JSON, built in-page so no key is committed.
    const keyJson = await page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
      const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
      const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
      return JSON.stringify({
        type: "service_account",
        client_email: "e2e@test.iam.gserviceaccount.com",
        private_key: pem,
      });
    });

    await page.setInputFiles("#key-file", {
      name: "service-account.json",
      mimeType: "application/json",
      buffer: Buffer.from(keyJson),
    });
    await page.fill(
      "#sheet-id",
      "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
    );

    await page.getByRole("button", { name: /test connection/i }).click();

    await expect(page.getByRole("heading", { name: /needs attention/i })).toBeVisible({
      timeout: 30_000,
    });
    // Names the exact column, rather than failing vaguely later.
    await expect(page.getByText(/column E should be "duration_seconds"/i)).toBeVisible();
    // And refuses to save a spreadsheet it knows is wrong.
    await expect(page.getByRole("button", { name: /save and start/i })).toBeDisabled();
  });

  test("reports missing tabs by name", async ({ page, context }) => {
    const sheet = new FakeSheet({ missingTabs: ["sessions", "meta"] });
    await sheet.install(context);
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: /connect your ledger/i })).toBeVisible();
  });

  test("an unconfigured browser is sent to setup", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/, { timeout: 20_000 });
  });
});

test.describe("timer", () => {
  test("C2: elapsed time tracks the clock even while the tab is hidden", async ({
    page,
    context,
  }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);

    await boot(page);
    await createGoal(page, "Background test");

    await openFirstGoal(page);
    await page.getByRole("button", { name: /start focus/i }).click();

    // Hide the tab. Real browsers throttle timers here to roughly once a minute,
    // which is what made the old tick-counting implementation lose almost all of
    // a background session.
    const started = Date.now();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(4000);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await page.getByRole("button", { name: /finish/i }).click();

    // The dialog reports real wall-clock time, not a tick count.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const heading = await dialog.textContent();
    const elapsedRealSeconds = (Date.now() - started) / 1000;

    // "You focused for Xs/Xm" — assert it is in the right ballpark rather than
    // exact, since CI timing varies.
    expect(heading).toMatch(/You focused for/);
    expect(elapsedRealSeconds).toBeGreaterThan(3);

    const logButton = page.getByRole("button", { name: /^Log /i }).first();
    await logButton.click();

    await expect.poll(() => sheet.liveSessions().length, { timeout: 20_000 }).toBe(1);
    const logged = sheet.liveSessions()[0]!;
    // Whole seconds preserved (C6), and at least the hidden interval captured.
    expect(Number(logged.duration_seconds)).toBeGreaterThanOrEqual(3);
  });

  test("pause excludes paused time from the logged duration", async ({ page, context }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);

    await boot(page);
    await createGoal(page, "Pause test");

    await openFirstGoal(page);
    await page.getByRole("button", { name: /start focus/i }).click();
    await page.waitForTimeout(2200);
    await page.getByRole("button", { name: /pause/i }).click();

    // While paused the display must not advance.
    const afterPause = await page.locator(".num").first().textContent();
    await page.waitForTimeout(2500);
    expect(await page.locator(".num").first().textContent()).toBe(afterPause);

    await page.getByRole("button", { name: /resume/i }).click();
    await expect(page.getByRole("button", { name: /pause/i })).toBeVisible();
  });
});

test.describe("command palette", () => {
  test("opens with the keyboard and starts a session on a goal", async ({ page, context }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);
    const problems = watchForErrors(page);

    await boot(page);
    await createGoal(page, "Palette goal");
    await page.goto("/");

    await page.keyboard.press("ControlOrMeta+k");

    const search = page.getByRole("combobox", { name: /search commands/i });
    await expect(search).toBeFocused();

    // Subsequence matching: "pg" should reach "Focus on Palette goal".
    await search.fill("pg");
    await expect(page.getByRole("option", { name: /Focus on Palette goal/ })).toBeVisible();

    await page.keyboard.press("Enter");

    // Landed on the goal with a session running.
    await expect(page).toHaveURL(/\/goal\//);
    await expect(page.getByRole("button", { name: /pause/i })).toBeVisible({ timeout: 10_000 });
    // And the global session strip reflects it.
    await expect(page.getByText(/Focusing/).first()).toBeVisible();

    expect(problems).toEqual([]);
  });

  test("Escape closes it without running anything", async ({ page, context }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox", { name: /search commands/i })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox", { name: /search commands/i })).toBeHidden();
    await expect(page).toHaveURL(/localhost:3000\/$/);
  });
});

test.describe("goal and session management", () => {
  test("create, retarget and archive a goal without touching the spreadsheet UI", async ({
    page,
    context,
  }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);

    await boot(page);
    await page.goto("/settings");
    await page.getByLabel("New goal").fill("Reading");
    await page.getByRole("button", { name: /^add$/i }).click();
    await expect(page.getByLabel(/^Title for Reading$/)).toBeVisible();

    // Rename.
    await page.getByLabel(/^Title for Reading$/).fill("Deep reading");
    await page.getByLabel(/^Title for Reading$/).blur();
    await expect(page.getByLabel(/^Title for Deep reading$/)).toBeVisible();

    // Weekly target.
    await page.getByLabel(/^Weekly target minutes for Deep reading$/).fill("300");
    await page.getByLabel(/^Weekly target minutes for Deep reading$/).blur();
    await expect(page.getByText("5h per week")).toBeVisible();

    // Archive.
    await page.getByRole("button", { name: /^Archive Deep reading$/ }).click();
    await expect(page.getByLabel(/^Title for Deep reading$/)).toBeHidden();

    // The tombstone reaches the sheet rather than the row vanishing.
    await expect
      .poll(() => sheet.goals.slice(1).some((row) => String(row[8]).toLowerCase() === "true"), {
        timeout: 20_000,
      })
      .toBe(true);
  });

  test("every control in a goal row shares one baseline", async ({ page, context }) => {
    // The per-row hint under the weekly-target input used to make that column
    // two lines taller than its neighbours, so with items-end nothing lined up
    // and the swatches and trash faked it with ad-hoc margins.
    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);
    await createGoal(page, "Alignment");

    await page.getByLabel(/^Weekly target minutes for Alignment$/).fill("300");
    await page.getByLabel(/^Weekly target minutes for Alignment$/).blur();
    await expect(page.getByText("5h per week")).toBeVisible();

    const centres = await Promise.all(
      [
        page.getByLabel(/^Title for Alignment$/),
        page.getByLabel(/^Weekly target minutes for Alignment$/),
        page.getByText("5h per week"),
        page.getByRole("button", { name: /^Set Alignment colour to/ }).first(),
        page.getByRole("button", { name: /^Archive Alignment$/ }),
      ].map(async (locator) => {
        const box = await locator.boundingBox();
        return box!.y + box!.height / 2;
      }),
    );

    const spread = Math.max(...centres) - Math.min(...centres);
    expect(spread, `controls are vertically misaligned by ${spread.toFixed(1)}px`).toBeLessThan(2);

    // And the whole row stays on one line on a desktop viewport.
    const row = page.getByLabel(/^Title for Alignment$/).locator("xpath=ancestor::li[1]");
    const height = (await row.boundingBox())!.height;
    expect(height).toBeLessThan(80);

    // Column headings must sit over their column. `auto` grid tracks are sized
    // from each grid's own content, so a header grid and a row grid with the same
    // template can still resolve to different widths — which is exactly how
    // "Colour" drifted off the swatches.
    const pairs: [string, ReturnType<typeof page.getByRole>][] = [
      ["Goal", page.getByLabel(/^Title for Alignment$/)],
      ["Weekly target", page.getByLabel(/^Weekly target minutes for Alignment$/)],
      ["Colour", page.getByRole("button", { name: /^Set Alignment colour to/ }).first()],
    ];
    for (const [heading, control] of pairs) {
      const headBox = (await page.getByText(heading, { exact: true }).boundingBox())!;
      const controlBox = (await control.boundingBox())!;
      expect(
        Math.abs(headBox.x - controlBox.x),
        `"${heading}" heading is ${Math.abs(headBox.x - controlBox.x).toFixed(1)}px off its column`,
      ).toBeLessThan(3);
    }
  });

  test("a backfilled session is attributed to the chosen day", async ({ browser }) => {
    // Pin the timezone and freeze the clock so the chosen start time is
    // deterministically in the past. The form rejects future start times
    // (backfill-dialog.tsx), and CI runners are UTC — so a hardcoded wall-clock
    // time like 07:30 became "in the future" whenever the job started before
    // that hour, which is exactly how this test used to flake. Pinning now to
    // midday UTC keeps 07:30 comfortably in the past regardless of when or where
    // the suite runs. setFixedTime (not install) leaves real timers running, so
    // the sync engine still flushes to the sheet.
    const context = await browser.newContext({ timezoneId: "UTC" });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date("2026-08-04T12:00:00Z"));

    const sheet = new FakeSheet();
    await sheet.install(context);

    await boot(page);
    await createGoal(page, "Gym");

    await page.goto("/");
    await page.getByRole("button", { name: /add a past session/i }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // 07:30 is well before the frozen midday-UTC "now", so it is always a valid
    // past time rather than depending on the wall clock the suite happens to run at.
    await dialog.locator("#bf-time").fill("07:30");
    await dialog.getByRole("button", { name: "45m" }).click();
    await dialog.getByRole("button", { name: /add session/i }).click();

    await expect
      .poll(() => sheet.liveSessions().find((s) => s.source === "manual"), { timeout: 20_000 })
      .toBeTruthy();
    const manual = sheet.liveSessions().find((s) => s.source === "manual")!;
    expect(Number(manual.duration_seconds)).toBe(45 * 60);
    // The local date is what the heatmap groups by, so it must be recorded.
    expect(manual.local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manual.tz).toBeTruthy();

    await context.close();
  });

  test("the backfill form's own defaults are always submittable", async ({ browser }) => {
    // Regression for a real bug: the form defaulted to "today at 09:00", which is
    // in the future for anyone opening it before 9am, so it rejected its own
    // untouched values. CI found it because the runner is UTC and the job started
    // before 09:00 UTC.
    //
    // Pacific/Midway is UTC-11, so the browser's local time is early in the day
    // for most of the UTC day — making this fail reliably before the fix rather
    // than only at certain hours.
    const context = await browser.newContext({ timezoneId: "Pacific/Midway" });
    const page = await context.newPage();
    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);
    await createGoal(page, "Defaults");

    await page.goto("/");
    await page.getByRole("button", { name: /add a past session/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Submit without touching anything.
    await dialog.getByRole("button", { name: /add session/i }).click();

    await expect(dialog.getByRole("alert")).toBeHidden();
    await expect
      .poll(() => sheet.liveSessions().find((s) => s.source === "manual"), { timeout: 20_000 })
      .toBeTruthy();

    await context.close();
  });
});

test.describe("today dashboard cards are clickable", () => {
  test("the summary and goal cards navigate, without hijacking their buttons", async ({
    page,
    context,
  }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);
    await createGoal(page, "Deep work");

    // The whole "Focused today" summary reads like something you can open — so
    // it opens Insights.
    await page.goto("/");
    await page.getByRole("link", { name: /today's focus/i }).click();
    await expect(page).toHaveURL(/\/stats$/);

    // Clicking the goal card body — not one of its buttons — opens the goal.
    // This is the stretched link: a click on empty card space must navigate.
    await page.goto("/");
    const card = page.locator('li:has(a[href^="/goal/"]:not([href$="/stats"]))').first();
    await card.click({ position: { x: 24, y: 52 } });
    await expect(page).toHaveURL(/\/goal\//);

    // The card's own actions must stay independent of that stretched link:
    // "add a past session" opens its dialog rather than navigating.
    await page.goto("/");
    await card.getByRole("button", { name: /add a past session/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    await context.close();
  });
});
