import { expect, test, type Page } from "@playwright/test";
import { FakeSheet, boot, createGoal, openFirstGoal } from "./helpers";

/**
 * Responsive guards.
 *
 * The assertion that earns its keep is horizontal overflow: it is the classic
 * mobile failure, it is invisible in a desktop viewport, and it is easy to
 * reintroduce with one wide table or fixed-width chart. Checking it on every
 * route means a regression fails CI rather than being noticed on a phone later.
 */

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };

/** Pixels the document scrolls horizontally. Anything above ~1 is a bug. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function expectNoOverflow(page: Page, label: string) {
  const overflow = await horizontalOverflow(page);
  expect(overflow, `${label} scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
}

test.describe("phone layout", () => {
  test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

  test("no route scrolls horizontally", async ({ page, context }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);

    await page.goto("/setup");
    await expectNoOverflow(page, "/setup");

    await boot(page);
    await expectNoOverflow(page, "/ (empty)");

    await createGoal(page, "Deep work");
    await createGoal(page, "Reading with a deliberately long goal name to stress the layout");
    await expectNoOverflow(page, "/settings");

    await page.goto("/");
    await expectNoOverflow(page, "/ (with goals)");

    // Log a session so the tables and charts have content to overflow with.
    await openFirstGoal(page);
    await expectNoOverflow(page, "/goal/[id] idle");

    await page.getByRole("button", { name: /start focus/i }).click();
    await page.waitForTimeout(2200);
    await expectNoOverflow(page, "/goal/[id] running");

    await page.getByRole("button", { name: /finish/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoOverflow(page, "log dialog");

    await page.getByRole("button", { name: /^Log /i }).first().click();
    await expect(page.getByRole("dialog")).toBeHidden();
    // The session table is the most likely thing to overflow.
    await expectNoOverflow(page, "/goal/[id] with sessions");

    const goalUrl = page.url();
    await page.goto(`${goalUrl}/stats`);
    // The heading on a goal's stats page is the goal name; "Insights" is the
    // small label above it.
    await expect(page.getByRole("heading", { name: "Deep work" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /last 26 weeks/i })).toBeVisible();
    await expectNoOverflow(page, "/goal/[id]/stats");

    await page.goto("/stats");
    await expect(page.getByRole("heading", { name: "Insights", exact: true })).toBeVisible();
    await expectNoOverflow(page, "/stats");
  });

  test("the nav rail collapses to icons and stays reachable", async ({ page, context }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);

    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();

    // Labels are hidden at this width, but the links must still be operable.
    const settings = nav.getByRole("link", { name: /settings/i });
    await expect(settings).toBeVisible();
    await settings.click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // The rail must not eat the screen.
    const width = await nav.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(80);
  });

  test("tap targets on the primary action are large enough", async ({ page, context }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);
    await boot(page);
    await createGoal(page, "Tap target");
    await openFirstGoal(page);

    const start = page.getByRole("button", { name: /start focus/i });
    const box = await start.boundingBox();
    // 44px is the long-standing minimum for a comfortable touch target.
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("tablet layout", () => {
  test.use({ viewport: TABLET });

  test("no route scrolls horizontally", async ({ page, context }) => {
    const sheet = new FakeSheet();
    await sheet.install(context);

    await boot(page);
    await createGoal(page, "Deep work");

    for (const route of ["/", "/stats", "/settings"]) {
      await page.goto(route);
      await page.waitForTimeout(600);
      await expectNoOverflow(page, route);
    }
  });
});
