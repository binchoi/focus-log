import { describe, expect, it } from "vitest";
import { SheetsClient } from "../sheets/client";
import { GOAL_COLUMNS, META_COLUMNS, RANGES, SESSION_COLUMNS, headerRow } from "../sheets/columns";
import { validateConnection, type ValidationReport } from "./validate";

const VALID_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

interface FakeOptions {
  tabs?: string[];
  goalHeader?: unknown[];
  sessionHeader?: unknown[];
  metaRows?: unknown[][];
  status?: number;
  networkError?: boolean;
}

function clientFor(options: FakeOptions = {}): SheetsClient {
  const {
    tabs = ["goals", "sessions", "meta"],
    goalHeader = headerRow(GOAL_COLUMNS),
    sessionHeader = headerRow(SESSION_COLUMNS),
    metaRows = [headerRow(META_COLUMNS), ["schema_version", 1]],
    status,
    networkError,
  } = options;

  const fetchImpl: typeof fetch = async (input) => {
    if (networkError) throw new TypeError("Failed to fetch");
    if (status) return new Response("error body", { status });

    const url = new URL(String(input));
    const body = url.pathname.endsWith(":batchGet")
      ? {
          valueRanges: url.searchParams.getAll("ranges").map((range) => ({
            values:
              range === RANGES.goals
                ? [goalHeader]
                : range === RANGES.sessions
                  ? [sessionHeader]
                  : metaRows,
          })),
        }
      : { sheets: tabs.map((title) => ({ properties: { title } })) };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return new SheetsClient({
    spreadsheetId: VALID_ID,
    tokens: { getAccessToken: async () => "token" },
    fetchImpl,
    retry: { maxAttempts: 1, sleep: async () => {}, jitter: () => 0 },
  });
}

const find = (report: ValidationReport, label: string) =>
  report.checks.find((c) => c.label.includes(label))!;

describe("validateConnection", () => {
  it("passes on a correctly set up spreadsheet", async () => {
    const report = await validateConnection(clientFor());
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.status !== "error")).toBe(true);
    expect(find(report, "Existing data").detail).toMatch(/Empty spreadsheet/);
  });

  it("explains a 403 as a sharing problem, with the fix", async () => {
    const report = await validateConnection(clientFor({ status: 403 }));
    expect(report.ok).toBe(false);
    expect(find(report, "Spreadsheet access").fix).toMatch(/Share the spreadsheet/);
  });

  it("explains a 404 as a wrong spreadsheet id", async () => {
    const report = await validateConnection(clientFor({ status: 404 }));
    expect(find(report, "Spreadsheet access").fix).toMatch(/between \/d\/ and \/edit/);
  });

  it("explains a 401 as a revoked key", async () => {
    const report = await validateConnection(clientFor({ status: 401 }));
    expect(find(report, "Spreadsheet access").fix).toMatch(/revoked/);
  });

  it("explains a network failure as a connectivity problem", async () => {
    const report = await validateConnection(clientFor({ networkError: true }));
    expect(find(report, "Spreadsheet access").fix).toMatch(/internet connection/);
  });

  it("names the missing tabs rather than failing vaguely", async () => {
    const report = await validateConnection(clientFor({ tabs: ["goals", "Sheet1"] }));
    expect(report.ok).toBe(false);
    const check = find(report, "Required tabs");
    expect(check.detail).toContain("sessions");
    expect(check.detail).toContain("meta");
    expect(check.detail).toContain("Sheet1");
  });

  it("catches a misspelled column and says exactly which one", async () => {
    const wrong = headerRow(SESSION_COLUMNS).slice();
    wrong[4] = "duration_mins";
    const report = await validateConnection(clientFor({ sessionHeader: wrong }));
    expect(report.ok).toBe(false);
    const check = find(report, 'Tab "sessions" header');
    expect(check.detail).toContain("column E");
    expect(check.detail).toContain("duration_seconds");
    expect(check.fix).toMatch(/Re-import sessions.csv/);
  });

  it("catches a column ordering swap", async () => {
    const swapped = headerRow(SESSION_COLUMNS).slice();
    [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
    const report = await validateConnection(clientFor({ sessionHeader: swapped }));
    expect(report.ok).toBe(false);
  });

  it("reports an empty tab as needing the CSV import", async () => {
    const report = await validateConnection(clientFor({ goalHeader: [] }));
    expect(report.ok).toBe(false);
    expect(find(report, 'Tab "goals" header').fix).toMatch(/Import goals.csv/);
  });

  it("tolerates extra user-added columns with a warning, not an error", async () => {
    const extra = [...headerRow(GOAL_COLUMNS), "my_own_notes"];
    const report = await validateConnection(clientFor({ goalHeader: extra }));
    expect(report.ok).toBe(true);
    expect(find(report, 'Tab "goals" header').status).toBe("warning");
  });

  it("refuses a spreadsheet written by a newer app version", async () => {
    // Writing to it could drop columns this build doesn't know about.
    const report = await validateConnection(
      clientFor({ metaRows: [headerRow(META_COLUMNS), ["schema_version", 99]] }),
    );
    expect(report.ok).toBe(false);
    expect(find(report, "Schema version").fix).toMatch(/Update focus-log/);
  });

  it("refuses an outdated spreadsheet and points at the template", async () => {
    const report = await validateConnection(
      clientFor({ metaRows: [headerRow(META_COLUMNS), ["schema_version", 0]] }),
    );
    expect(report.ok).toBe(false);
    expect(find(report, "Schema version").fix).toMatch(/Re-import the CSV template/);
  });

  it("warns but proceeds when schema_version is absent", async () => {
    const report = await validateConnection(clientFor({ metaRows: [headerRow(META_COLUMNS)] }));
    expect(report.ok).toBe(true);
    expect(find(report, "Schema version").status).toBe("warning");
  });

  it("reports existing row counts so the user knows the sheet isn't empty", async () => {
    const client = clientFor();
    // Re-wrap with extra data rows.
    const withData = new SheetsClient({
      spreadsheetId: VALID_ID,
      tokens: { getAccessToken: async () => "token" },
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (!url.pathname.endsWith(":batchGet")) {
          return new Response(
            JSON.stringify({ sheets: ["goals", "sessions", "meta"].map((t) => ({ properties: { title: t } })) }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            valueRanges: url.searchParams.getAll("ranges").map((range) => ({
              values:
                range === RANGES.goals
                  ? [headerRow(GOAL_COLUMNS), ["g1"], ["g2"]]
                  : range === RANGES.sessions
                    ? [headerRow(SESSION_COLUMNS), ["s1"]]
                    : [headerRow(META_COLUMNS), ["schema_version", 1]],
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      retry: { maxAttempts: 1, sleep: async () => {}, jitter: () => 0 },
    });
    expect(client).toBeDefined();

    const report = await validateConnection(withData);
    expect(find(report, "Existing data").detail).toMatch(/2 goal row\(s\).*1 session row\(s\)/);
  });
});
