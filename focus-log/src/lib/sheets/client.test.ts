import { describe, expect, it, vi } from "vitest";
import { RANGES } from "./columns";
import {
  DEFAULT_RETRY,
  SheetsClient,
  SheetsError,
  backoffDelay,
  extractSpreadsheetId,
  isValidSpreadsheetId,
  type TokenProvider,
} from "./client";

const VALID_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

function tokens(): TokenProvider & { invalidated: number } {
  const provider = {
    invalidated: 0,
    getAccessToken: async () => "test-token",
    invalidate: () => {
      provider.invalidated += 1;
    },
  };
  return provider;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Never actually waits, and makes jitter deterministic. */
const fastRetry = { sleep: async () => {}, jitter: () => 0 } as const;

describe("isValidSpreadsheetId", () => {
  it("accepts a real spreadsheet id", () => {
    expect(isValidSpreadsheetId(VALID_ID)).toBe(true);
  });

  it("rejects values that would reshape the request path", () => {
    // The old code interpolated this straight into the URL with no validation.
    for (const bad of [
      "../../../etc/passwd",
      "abc/def/ghi/jklmnopqrstuvwxyz",
      "short",
      "has spaces in it here ok",
      "id?with=query&params=here12345678",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(isValidSpreadsheetId(bad)).toBe(false);
    }
  });

  it("refuses to construct a client with an invalid id", () => {
    expect(() => new SheetsClient({ spreadsheetId: "../evil", tokens: tokens() })).toThrow(
      /Invalid spreadsheet ID/,
    );
  });
});

describe("extractSpreadsheetId", () => {
  it("pulls the id out of a pasted URL, including the gid fragment form", () => {
    expect(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${VALID_ID}/edit`)).toBe(
      VALID_ID,
    );
    expect(
      extractSpreadsheetId(
        `https://docs.google.com/spreadsheets/d/${VALID_ID}/edit?gid=1379805797#gid=1379805797`,
      ),
    ).toBe(VALID_ID);
    expect(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${VALID_ID}`)).toBe(VALID_ID);
  });

  it("passes a bare id through, trimming whitespace", () => {
    expect(extractSpreadsheetId(VALID_ID)).toBe(VALID_ID);
    expect(extractSpreadsheetId(`  ${VALID_ID}  `)).toBe(VALID_ID);
  });

  it("returns the input unchanged when there is no id to find, so validation can reject it", () => {
    expect(extractSpreadsheetId("not a url")).toBe("not a url");
    expect(isValidSpreadsheetId(extractSpreadsheetId("not a url"))).toBe(false);
  });
});

describe("backoffDelay", () => {
  const policy = { ...DEFAULT_RETRY, jitter: () => 0 };

  it("grows exponentially", () => {
    expect(backoffDelay(1, policy)).toBe(250);
    expect(backoffDelay(2, policy)).toBe(500);
    expect(backoffDelay(3, policy)).toBe(1000);
  });

  it("honours Retry-After over its own schedule", () => {
    expect(backoffDelay(1, policy, 30)).toBe(30_000);
  });

  it("caps at maxDelayMs", () => {
    expect(backoffDelay(40, policy)).toBe(policy.maxDelayMs);
    expect(backoffDelay(1, policy, 99_999)).toBe(policy.maxDelayMs);
  });

  it("applies jitter between 50% and 100% of the exponential delay", () => {
    expect(backoffDelay(3, { ...policy, jitter: () => 0 })).toBe(1000);
    expect(backoffDelay(3, { ...policy, jitter: () => 1 })).toBe(2000);
  });
});

describe("batchGet", () => {
  it("requests UNFORMATTED_VALUE so grouped numbers never appear (C8)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ valueRanges: [{ values: [["a"]] }] }));
    const client = new SheetsClient({ spreadsheetId: VALID_ID, tokens: tokens(), fetchImpl });
    await client.batchGet([RANGES.goals]);

    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
  });

  it("reads all three tabs in a single request (C17)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        valueRanges: [{ values: [["goal"]] }, { values: [["session"]] }, { values: [["meta"]] }],
      }),
    );
    const client = new SheetsClient({ spreadsheetId: VALID_ID, tokens: tokens(), fetchImpl });
    const result = await client.readAll();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.goals).toEqual([["goal"]]);
    expect(result.sessions).toEqual([["session"]]);
    expect(result.meta).toEqual([["meta"]]);
  });

  it("keys results by the requested range, not Google's rewritten range", async () => {
    // Google echoes back a normalised range like "goals!A1:J1000".
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ valueRanges: [{ range: "goals!A1:J1000", values: [["x"]] }] }),
    );
    const client = new SheetsClient({ spreadsheetId: VALID_ID, tokens: tokens(), fetchImpl });
    const values = await client.batchGet([RANGES.goals]);
    expect(values.get(RANGES.goals)).toEqual([["x"]]);
  });

  it("treats a missing values array as an empty tab", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ valueRanges: [{}] }));
    const client = new SheetsClient({ spreadsheetId: VALID_ID, tokens: tokens(), fetchImpl });
    expect((await client.batchGet([RANGES.goals])).get(RANGES.goals)).toEqual([]);
  });
});

describe("append", () => {
  it("uses RAW so ISO timestamps and ids are stored verbatim", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const client = new SheetsClient({ spreadsheetId: VALID_ID, tokens: tokens(), fetchImpl });
    await client.append(RANGES.sessions, [["0012", "2026-07-29T10:00:00.000Z", 60]]);

    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.searchParams.get("valueInputOption")).toBe("RAW");
    expect(url.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");
  });

  it("sends nothing when there are no rows", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const client = new SheetsClient({ spreadsheetId: VALID_ID, tokens: tokens(), fetchImpl });
    await client.append(RANGES.sessions, []);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("batches many rows into one request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const client = new SheetsClient({ spreadsheetId: VALID_ID, tokens: tokens(), fetchImpl });
    await client.append(RANGES.sessions, [["a"], ["b"], ["c"]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.values).toHaveLength(3);
  });
});

describe("error handling", () => {
  it("retries a 429 and honours Retry-After", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(jsonResponse({ valueRanges: [] }));

    const client = new SheetsClient({
      spreadsheetId: VALID_ID,
      tokens: tokens(),
      fetchImpl,
      retry: { ...fastRetry, sleep: async (ms) => void sleeps.push(ms) },
    });

    await client.batchGet([RANGES.goals]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });

  it("retries a 500", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ valueRanges: [] }));
    const client = new SheetsClient({
      spreadsheetId: VALID_ID,
      tokens: tokens(),
      fetchImpl,
      retry: fastRetry,
    });
    await client.batchGet([RANGES.goals]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a network failure (the offline case)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ valueRanges: [] }));
    const client = new SheetsClient({
      spreadsheetId: VALID_ID,
      tokens: tokens(),
      fetchImpl,
      retry: fastRetry,
    });
    await client.batchGet([RANGES.goals]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and reports it as retryable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 503 }));
    const client = new SheetsClient({
      spreadsheetId: VALID_ID,
      tokens: tokens(),
      fetchImpl,
      retry: { ...fastRetry, maxAttempts: 3 },
    });

    await expect(client.batchGet([RANGES.goals])).rejects.toMatchObject({
      name: "SheetsError",
      kind: "server",
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 403, and explains the likely cause", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 }));
    const client = new SheetsClient({
      spreadsheetId: VALID_ID,
      tokens: tokens(),
      fetchImpl,
      retry: fastRetry,
    });

    await expect(client.batchGet([RANGES.goals])).rejects.toThrow(/shared with the service account/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 404", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("missing", { status: 404 }));
    const client = new SheetsClient({
      spreadsheetId: VALID_ID,
      tokens: tokens(),
      fetchImpl,
      retry: fastRetry,
    });
    await expect(client.batchGet([RANGES.goals])).rejects.toMatchObject({ kind: "not_found" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("invalidates the cached token on a 401 before retrying", async () => {
    const provider = tokens();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ valueRanges: [] }));
    const client = new SheetsClient({
      spreadsheetId: VALID_ID,
      tokens: provider,
      fetchImpl,
      retry: fastRetry,
    });

    await client.batchGet([RANGES.goals]);
    expect(provider.invalidated).toBe(1);
  });

  it("exposes SheetsError for callers to branch on", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("bad", { status: 400 }));
    const client = new SheetsClient({
      spreadsheetId: VALID_ID,
      tokens: tokens(),
      fetchImpl,
      retry: fastRetry,
    });
    await expect(client.batchGet([RANGES.goals])).rejects.toBeInstanceOf(SheetsError);
  });
});

describe("listTabs", () => {
  it("returns tab titles for connection validation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        sheets: [
          { properties: { title: "goals" } },
          { properties: { title: "sessions" } },
          { properties: {} },
        ],
      }),
    );
    const client = new SheetsClient({ spreadsheetId: VALID_ID, tokens: tokens(), fetchImpl });
    expect(await client.listTabs()).toEqual(["goals", "sessions"]);
  });
});
