/**
 * Service-account credentials and JWT minting.
 *
 * The old app stored the raw PEM private key in localStorage as plaintext
 * (C4). That key has `auth/spreadsheets` scope, never expires, and — per the
 * project README — was shared between users, so any XSS or bad dependency
 * exfiltrated permanent write access to everyone's spreadsheet.
 *
 * Here the PEM is imported once with `extractable: false` and only the
 * resulting CryptoKey is persisted. Verified behaviour:
 *
 *   importKey(..., extractable=false, ["sign"])  ->  key.extractable === false
 *   crypto.subtle.sign(...)                      ->  works, 256-byte signature
 *   crypto.subtle.exportKey("pkcs8", key)        ->  InvalidAccessException
 *   structuredClone(key)                         ->  works, so IndexedDB persists it
 *
 * So the user never logs out and never re-enters anything (the explicit
 * requirement: convenience over hardening), yet the key material itself can no
 * longer be read back out by script.
 *
 * Honest limit: script running on this origin can still *use* the key while the
 * page is open. It just cannot steal a durable credential to use elsewhere,
 * later. The CSP in next.config.mjs narrows the blast radius further.
 */

import { db, type FocusLogDb, type StoredCredentials } from "../store/db";
import type { TokenProvider } from "../sheets/client";
import { isValidSpreadsheetId } from "../sheets/client";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_LIFETIME_SECONDS = 3600;
/** Refresh this far before expiry so a long request can't straddle it. */
const REFRESH_MARGIN_SECONDS = 300;

export interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  [key: string]: unknown;
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

/** Parses and validates a service-account JSON file without storing anything. */
export function parseServiceAccountJson(text: string): ServiceAccountJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CredentialError("That file isn't valid JSON. Upload the key file Google gave you.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new CredentialError("That file isn't a service account key.");
  }
  const candidate = parsed as Partial<ServiceAccountJson>;

  if (typeof candidate.client_email !== "string" || !candidate.client_email.includes("@")) {
    throw new CredentialError("This key file has no client_email. Is it a service account key?");
  }
  if (typeof candidate.private_key !== "string" || !candidate.private_key.includes("PRIVATE KEY")) {
    throw new CredentialError("This key file has no private_key. Is it a service account key?");
  }
  return candidate as ServiceAccountJson;
}

/** PEM (with real or escaped newlines) to the DER bytes importKey expects. */
export function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  if (body.length === 0) throw new CredentialError("The private key in this file is empty.");

  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new CredentialError("The private key in this file isn't valid base64.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Imports the PEM as a **non-extractable** signing key.
 * Once this returns, the caller should drop the PEM string; it is never stored.
 */
export async function importSigningKey(pem: string): Promise<CryptoKey> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, // extractable: false — the whole point
      ["sign"],
    );
  } catch (cause) {
    if (cause instanceof CredentialError) throw cause;
    throw new CredentialError(
      "Could not read the private key. Make sure you pasted the whole key file, unmodified.",
    );
  }

  // Belt and braces: if a future platform silently ignored extractable:false we
  // would be storing a stealable key while believing otherwise.
  if (key.extractable) {
    throw new CredentialError("This browser could not protect the private key. Setup aborted.");
  }
  return key;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Mints and signs a Google service-account assertion JWT. */
export async function createAssertion(
  clientEmail: string,
  key: CryptoKey,
  nowSeconds: number,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface SaveCredentialsInput {
  serviceAccount: ServiceAccountJson;
  spreadsheetId: string;
}

export async function saveCredentials(
  input: SaveCredentialsInput,
  database: FocusLogDb = db(),
): Promise<StoredCredentials> {
  if (!isValidSpreadsheetId(input.spreadsheetId)) {
    throw new CredentialError(
      "That doesn't look like a spreadsheet ID. Copy the long string between /d/ and /edit in the spreadsheet URL.",
    );
  }

  const privateKey = await importSigningKey(input.serviceAccount.private_key);
  const record: StoredCredentials = {
    id: "default",
    clientEmail: input.serviceAccount.client_email,
    spreadsheetId: input.spreadsheetId,
    privateKey,
    createdAt: new Date().toISOString(),
  };
  await database.credentials.put(record);
  return record;
}

export async function loadCredentials(
  database: FocusLogDb = db(),
): Promise<StoredCredentials | undefined> {
  return database.credentials.get("default");
}

export async function clearCredentials(database: FocusLogDb = db()): Promise<void> {
  await database.credentials.delete("default");
}

export async function hasCredentials(database: FocusLogDb = db()): Promise<boolean> {
  return (await loadCredentials(database)) !== undefined;
}

// ---------------------------------------------------------------------------
// Token provider
// ---------------------------------------------------------------------------

export interface ServiceAccountTokenOptions {
  clientEmail: string;
  privateKey: CryptoKey;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Caches the access token in memory and mints a new one only when it is close
 * to expiring.
 *
 * The old code minted a fresh JWT — an RSA signature plus a token exchange
 * round-trip — on every single API call, so loading the home page did it three
 * times (C17).
 */
export class ServiceAccountTokenProvider implements TokenProvider {
  private cached: { token: string; expiresAtMs: number } | undefined;
  private pending: Promise<string> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ServiceAccountTokenOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  async getAccessToken(): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAtMs - REFRESH_MARGIN_SECONDS * 1000 > this.now()) {
      return cached.token;
    }
    // Collapse concurrent misses into one exchange, so a burst of parallel
    // requests doesn't mint several tokens.
    this.pending ??= this.exchange().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const assertion = await createAssertion(this.options.clientEmail, this.options.privateKey, nowSeconds);

    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      });
    } catch (cause) {
      throw new CredentialError(
        `Could not reach Google to sign in: ${(cause as Error)?.message ?? "network error"}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // 400 invalid_grant from this endpoint almost always means the key was
      // revoked or the clock is badly skewed — worth saying so.
      throw new CredentialError(
        `Google rejected these credentials (${response.status}). ` +
          `The service account key may have been revoked or deleted. ${body.slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new CredentialError("Google returned no access token.");
    }

    const lifetime = (payload.expires_in ?? TOKEN_LIFETIME_SECONDS) * 1000;
    this.cached = { token: payload.access_token, expiresAtMs: this.now() + lifetime };
    return payload.access_token;
  }
}

export function tokenProviderFor(credentials: StoredCredentials): ServiceAccountTokenProvider {
  return new ServiceAccountTokenProvider({
    clientEmail: credentials.clientEmail,
    privateKey: credentials.privateKey,
  });
}
