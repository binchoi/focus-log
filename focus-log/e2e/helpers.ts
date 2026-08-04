import type { BrowserContext, Page, Route } from "@playwright/test";

/**
 * Test harness for the Google Sheets API.
 *
 * Behaves like the real thing in the way that matters: appends accumulate and
 * nothing is ever updated in place, so the append-only semantics the sync engine
 * depends on are actually exercised rather than assumed.
 */

export const SHEET_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

export const GOAL_HEADER = [
  "goal_id",
  "title",
  "color",
  "weekly_target_minutes",
  "sort_order",
  "status",
  "created_at",
  "updated_at",
  "deleted",
  "device_id",
];

export const SESSION_HEADER = [
  "log_id",
  "goal_id",
  "start_utc",
  "end_utc",
  "duration_seconds",
  "local_date",
  "tz",
  "note",
  "source",
  "updated_at",
  "deleted",
  "device_id",
];

export const ACTIVE_HEADER = [
  "log_id",
  "goal_id",
  "segments",
  "note",
  "updated_at",
  "deleted",
  "device_id",
];

export interface FakeSheetOptions {
  /** Break a header so setup validation has something to reject. */
  corruptSessionHeader?: boolean;
  /** Omit tabs so validation reports them missing. */
  missingTabs?: string[];
  /** Status to fail every request with. */
  failWith?: number;
  /**
   * Append succeeds and the row is stored, but the response is destroyed — the
   * "write landed, reply lost" case that idempotency has to survive.
   */
  swallowAppendResponses?: boolean;
  /** Enable the v2 `active` tab (cross-device timer). */
  v2?: boolean;
}

export class FakeSheet {
  goals: unknown[][] = [GOAL_HEADER];
  sessions: unknown[][] = [SESSION_HEADER];
  active: unknown[][] = [ACTIVE_HEADER];
  meta: unknown[][];
  appendCalls = 0;
  tokenCalls = 0;

  constructor(private readonly options: FakeSheetOptions = {}) {
    this.meta = [
      ["key", "value"],
      ["schema_version", options.v2 ? 2 : 1],
    ];
  }

  private get v2(): boolean {
    return this.options.v2 === true;
  }

  /** Live (non-tombstoned) active-timer rows reduced by last-write-wins. */
  liveActive(): Record<string, string>[] {
    const latest = new Map<string, Record<string, string>>();
    for (const row of this.active.slice(1)) {
      const record: Record<string, string> = {};
      ACTIVE_HEADER.forEach((key, i) => (record[key] = String(row[i] ?? "")));
      const existing = latest.get(record.log_id!);
      if (!existing || Date.parse(record.updated_at!) >= Date.parse(existing.updated_at!)) {
        latest.set(record.log_id!, record);
      }
    }
    return [...latest.values()].filter((r) => r.deleted !== "true" && r.deleted !== "TRUE");
  }

  /** Rows reduced by last-write-wins, as the app would see them. */
  liveSessions(): Record<string, string>[] {
    const latest = new Map<string, Record<string, string>>();
    for (const row of this.sessions.slice(1)) {
      const record: Record<string, string> = {};
      SESSION_HEADER.forEach((key, i) => (record[key] = String(row[i] ?? "")));
      const existing = latest.get(record.log_id!);
      if (!existing || Date.parse(record.updated_at!) >= Date.parse(existing.updated_at!)) {
        latest.set(record.log_id!, record);
      }
    }
    return [...latest.values()].filter((r) => r.deleted !== "true" && r.deleted !== "TRUE");
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route("https://oauth2.googleapis.com/**", (route) => {
      this.tokenCalls += 1;
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ access_token: "test-token", expires_in: 3600 }),
      });
    });

    await context.route("https://sheets.googleapis.com/**", (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());

    if (this.options.failWith) {
      return route.fulfill({ status: this.options.failWith, body: "denied" });
    }

    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    // A v1 sheet has no `active` tab: Google 400s any read/write of it.
    const missingActive = (range: string) => range.startsWith("active") && !this.v2;
    const badRange = () =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: 400, message: "Unable to parse range: active" } }),
      });

    // Spreadsheet metadata (tab listing) for connection validation.
    if (
      url.pathname.endsWith(`/${SHEET_ID}`) ||
      url.searchParams.get("fields")?.includes("sheets")
    ) {
      const tabs = ["goals", "sessions", "meta", ...(this.v2 ? ["active"] : [])].filter(
        (t) => !(this.options.missingTabs ?? []).includes(t),
      );
      return json({ sheets: tabs.map((title) => ({ properties: { title } })) });
    }

    if (url.pathname.endsWith(":batchGet")) {
      const ranges = url.searchParams.getAll("ranges");
      if (ranges.some(missingActive)) return badRange();
      return json({
        valueRanges: ranges.map((range) => {
          if (range.startsWith("goals")) return { values: this.goals };
          if (range.startsWith("active")) return { values: this.active };
          if (range.startsWith("sessions")) {
            const rows = [...this.sessions];
            if (this.options.corruptSessionHeader) {
              rows[0] = SESSION_HEADER.map((h) => (h === "duration_seconds" ? "duration_mins" : h));
            }
            return { values: rows };
          }
          return { values: this.meta };
        }),
      });
    }

    if (url.pathname.endsWith(":append")) {
      const body = JSON.parse(request.postData() ?? "{}") as {
        range: string;
        values: unknown[][];
      };
      if (missingActive(body.range)) return badRange();
      this.appendCalls += 1;
      const target = body.range.startsWith("goals")
        ? this.goals
        : body.range.startsWith("active")
          ? this.active
          : this.sessions;
      target.push(...body.values);
      if (this.options.swallowAppendResponses) {
        // Row is durably stored; the client never learns that.
        return route.abort("connectionreset");
      }
      return json({ updates: { updatedRows: body.values.length } });
    }

    return json({});
  }
}

/**
 * Seeds credentials directly into IndexedDB.
 *
 * Generates a real RSA key in-page and imports it non-extractable, exactly as
 * the app does, so the stored shape is genuine. This skips the setup UI for tests
 * that are about something else; setup itself is covered by its own spec.
 */
export async function seedCredentials(page: Page): Promise<void> {
  await page.evaluate(async (spreadsheetId) => {
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
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, // non-extractable, as the app stores it
      ["sign"],
    );

    // The app has already opened the database, so attach without a version and
    // write into the existing store rather than racing Dexie's upgrade.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("focus-log");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("credentials", "readwrite");
      tx.objectStore("credentials").put({
        id: "default",
        clientEmail: "e2e@test.iam.gserviceaccount.com",
        spreadsheetId,
        privateKey,
        createdAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, SHEET_ID);
}

/**
 * Boots a configured app.
 *
 * The order matters: the first navigation lands on /setup (no credentials yet),
 * which is where the app opens its IndexedDB. Only then can credentials be
 * seeded — and afterwards we must *navigate* to "/" rather than reload, because
 * reloading would just reload /setup.
 */
export async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForURL(/\/setup$/, { timeout: 20_000 });
  await seedCredentials(page);
  await page.goto("/");
  await page.getByRole("heading", { name: "Today", exact: true }).waitFor({ timeout: 20_000 });
}

/** Creates a goal through the settings UI and waits for it to exist. */
export async function createGoal(page: Page, title: string): Promise<void> {
  await page.goto("/settings");
  await page.getByLabel("New goal").fill(title);
  await page.getByRole("button", { name: /^add$/i }).click();
  await page.getByLabel(`Title for ${title}`).waitFor({ timeout: 15_000 });
}

/** Opens the timer screen for the first goal on the dashboard. */
export async function openFirstGoal(page: Page): Promise<void> {
  await page.goto("/");
  // Target the card's primary action by href, so it cannot match the rail or
  // the "See all insights" link.
  await page.locator('a[href^="/goal/"]:not([href$="/stats"])').first().click();
  await page
    .getByRole("button", { name: /start focus|pause|resume/i })
    .waitFor({ timeout: 15_000 });
}

/** Collects console errors and page errors so a test can assert there were none. */
export function watchForErrors(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}
