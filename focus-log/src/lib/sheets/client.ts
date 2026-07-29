/**
 * Google Sheets v4 client.
 *
 * Built on `fetch` rather than axios (which contributed ~30 advisories to the
 * browser bundle) and deliberately narrow: batched reads, appends, and the one
 * clear-and-rewrite used by sheet compaction.
 *
 * Reads always use UNFORMATTED_VALUE and writes always use RAW. That pairing is
 * load-bearing:
 *   - UNFORMATTED_VALUE stops 1234 arriving as "1,234" (C8).
 *   - RAW stops Sheets re-parsing our ISO timestamps into date serials and
 *     stops an id like "0012" becoming the number 12.
 */

import { RANGES, type Cell, type Row, type TabName } from "./columns";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** A spreadsheet id as it appears in the document URL. */
const SPREADSHEET_ID_RE = /^[A-Za-z0-9_-]{20,64}$/;

export function isValidSpreadsheetId(id: unknown): id is string {
  return typeof id === "string" && SPREADSHEET_ID_RE.test(id);
}

/**
 * Supplies a bearer token. Implemented by the auth module in Phase 3; kept as
 * an interface so this client is testable without any credentials.
 */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Called after a 401 so the next attempt mints a fresh token. */
  invalidate?(): void;
}

export class SheetsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind:
      | "auth"
      | "permission"
      | "not_found"
      | "rate_limit"
      | "server"
      | "network"
      | "bad_request",
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SheetsError";
  }
}

function classify(status: number, body: string): SheetsError {
  const detail = body.slice(0, 400);
  switch (true) {
    case status === 401:
      return new SheetsError(`Credentials rejected by Google. ${detail}`, status, "auth", true);
    case status === 403:
      return new SheetsError(
        `Access denied. Is the spreadsheet shared with the service account as an Editor? ${detail}`,
        status,
        "permission",
        false,
      );
    case status === 404:
      return new SheetsError(
        `Spreadsheet or tab not found. Check the spreadsheet ID and tab names. ${detail}`,
        status,
        "not_found",
        false,
      );
    case status === 429:
      return new SheetsError(`Rate limited by Google. ${detail}`, status, "rate_limit", true);
    case status >= 500:
      return new SheetsError(`Google Sheets is unavailable. ${detail}`, status, "server", true);
    default:
      return new SheetsError(`Sheets request failed (${status}). ${detail}`, status, "bad_request", false);
  }
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected so tests do not actually wait. */
  sleep: (ms: number) => Promise<void>;
  /** Injected so backoff jitter is deterministic in tests. */
  jitter: () => number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 5 * 60 * 1000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  jitter: () => Math.random(),
};

export function backoffDelay(attempt: number, policy: RetryPolicy, retryAfterSeconds?: number): number {
  // Google's Retry-After is authoritative when present.
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    return Math.min(retryAfterSeconds * 1000, policy.maxDelayMs);
  }
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  // Full jitter: spreads retries so multiple queued writes don't sync up.
  return Math.min(Math.round(exponential * (0.5 + 0.5 * policy.jitter())), policy.maxDelayMs);
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds;
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) return Math.max(0, (asDate - Date.now()) / 1000);
  return undefined;
}

export interface SheetsClientOptions {
  spreadsheetId: string;
  tokens: TokenProvider;
  fetchImpl?: typeof fetch;
  retry?: Partial<RetryPolicy>;
}

export class SheetsClient {
  private readonly spreadsheetId: string;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryPolicy;

  constructor(options: SheetsClientOptions) {
    if (!isValidSpreadsheetId(options.spreadsheetId)) {
      // The old code interpolated this straight into the request URL with no
      // validation, so a stray "/" or ".." reshaped the request path.
      throw new Error(
        "Invalid spreadsheet ID. Copy the long string between /d/ and /edit in the spreadsheet URL.",
      );
    }
    this.spreadsheetId = options.spreadsheetId;
    this.tokens = options.tokens;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
  }

  private url(path: string, params: Record<string, string | string[]> = {}): string {
    const url = new URL(`${SHEETS_BASE}/${encodeURIComponent(this.spreadsheetId)}${path}`);
    for (const [key, value] of Object.entries(params)) {
      for (const single of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, single);
      }
    }
    return url.toString();
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    let lastError: SheetsError | undefined;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        const token = await this.tokens.getAccessToken();
        response = await this.fetchImpl(url, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
      } catch (cause) {
        // Offline, DNS failure, CORS — always worth retrying.
        lastError = new SheetsError(
          `Network request to Google Sheets failed: ${(cause as Error)?.message ?? "unknown"}`,
          0,
          "network",
          true,
        );
        if (attempt === this.retry.maxAttempts) break;
        await this.retry.sleep(backoffDelay(attempt, this.retry));
        continue;
      }

      if (response.ok) return (await response.json()) as T;

      const body = await response.text().catch(() => "");
      const error = classify(response.status, body);
      lastError = error;

      if (error.kind === "auth") this.tokens.invalidate?.();
      if (!error.retryable || attempt === this.retry.maxAttempts) break;

      await this.retry.sleep(backoffDelay(attempt, this.retry, parseRetryAfter(response.headers)));
    }

    throw lastError ?? new SheetsError("Sheets request failed", 0, "network", true);
  }

  /**
   * Reads every tab in one round-trip.
   *
   * The old app made two separate GETs for the home page and then a third for
   * logs — and the stats page called fetchLogs() twice because two chart
   * components each fetched independently (C17).
   */
  async batchGet(ranges: readonly string[]): Promise<Map<string, Row[]>> {
    const payload = await this.request<{
      valueRanges?: { range?: string; values?: Row[] }[];
    }>(
      this.url("/values:batchGet", {
        ranges: [...ranges],
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      }),
      { method: "GET" },
    );

    const result = new Map<string, Row[]>();
    (payload.valueRanges ?? []).forEach((valueRange, index) => {
      // Google echoes a normalised range ("sessions!A1:L1000"), so key by the
      // range we asked for rather than trying to match its rewrite.
      const requested = ranges[index];
      if (requested !== undefined) result.set(requested, valueRange.values ?? []);
    });
    return result;
  }

  /** Reads all three tabs of the focus-log schema. */
  async readAll(): Promise<{ goals: Row[]; sessions: Row[]; meta: Row[] }> {
    const values = await this.batchGet([RANGES.goals, RANGES.sessions, RANGES.meta]);
    return {
      goals: values.get(RANGES.goals) ?? [],
      sessions: values.get(RANGES.sessions) ?? [],
      meta: values.get(RANGES.meta) ?? [],
    };
  }

  /**
   * Appends rows. Every mutation in focus-log is an append — see
   * src/lib/sync/merge.ts for why nothing is ever updated in place.
   */
  async append(range: string, rows: readonly Cell[][]): Promise<void> {
    if (rows.length === 0) return;
    await this.request(
      this.url(`/values/${encodeURIComponent(range)}:append`, {
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
      }),
      { method: "POST", body: JSON.stringify({ range, majorDimension: "ROWS", values: rows }) },
    );
  }

  /** Replaces a tab's contents with `rows` (header included). Used by compaction. */
  async replaceTab(tab: TabName, range: string, rows: readonly Cell[][]): Promise<void> {
    await this.request(this.url(`/values/${encodeURIComponent(range)}:clear`), { method: "POST", body: "{}" });
    if (rows.length === 0) return;
    await this.request(
      this.url(`/values/${encodeURIComponent(`${tab}!A1`)}`, { valueInputOption: "RAW" }),
      { method: "PUT", body: JSON.stringify({ range: `${tab}!A1`, majorDimension: "ROWS", values: rows }) },
    );
  }

  /** Tab titles that actually exist, for connection validation. */
  async listTabs(): Promise<string[]> {
    const payload = await this.request<{ sheets?: { properties?: { title?: string } }[] }>(
      this.url("", { fields: "sheets.properties.title" }),
      { method: "GET" },
    );
    return (payload.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => typeof t === "string");
  }
}
