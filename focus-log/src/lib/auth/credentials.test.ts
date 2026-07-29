import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FocusLogDb, setDbForTests } from "../store/db";
import {
  CredentialError,
  ServiceAccountTokenProvider,
  clearCredentials,
  createAssertion,
  hasCredentials,
  importSigningKey,
  loadCredentials,
  parseServiceAccountJson,
  pemToPkcs8,
  saveCredentials,
  type ServiceAccountJson,
} from "./credentials";

const VALID_SHEET_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

let pem: string;
let serviceAccount: ServiceAccountJson;
let dbCounter = 0;
let database: FocusLogDb;

/** Generates a real RSA key and exports it as PEM, like Google's key file. */
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const wrapped = b64.match(/.{1,64}/g)!.join("\n");
  pem = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
  serviceAccount = { client_email: "focus-log@test.iam.gserviceaccount.com", private_key: pem };
});

beforeEach(async () => {
  dbCounter += 1;
  database = new FocusLogDb(`focus-log-auth-${dbCounter}`);
  setDbForTests(database);
  await database.open();
});

describe("parseServiceAccountJson", () => {
  it("accepts a real service account key file", () => {
    const parsed = parseServiceAccountJson(JSON.stringify(serviceAccount));
    expect(parsed.client_email).toBe(serviceAccount.client_email);
  });

  it("explains what's wrong rather than throwing a raw parse error", () => {
    expect(() => parseServiceAccountJson("not json")).toThrow(/isn't valid JSON/);
    expect(() => parseServiceAccountJson("null")).toThrow(/isn't a service account key/);
    expect(() => parseServiceAccountJson(JSON.stringify({ private_key: pem }))).toThrow(/no client_email/);
    expect(() =>
      parseServiceAccountJson(JSON.stringify({ client_email: "a@b.com", private_key: "junk" })),
    ).toThrow(/no private_key/);
  });
});

describe("pemToPkcs8", () => {
  it("handles a PEM with real newlines", () => {
    expect(pemToPkcs8(pem).byteLength).toBeGreaterThan(1000);
  });

  it("handles a PEM with escaped \\n, as it appears inside JSON", () => {
    const escaped = pem.replace(/\n/g, "\\n");
    expect(pemToPkcs8(escaped).byteLength).toBe(pemToPkcs8(pem).byteLength);
  });

  it("rejects an empty or non-base64 key", () => {
    expect(() => pemToPkcs8("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----")).toThrow(
      /empty/,
    );
    expect(() => pemToPkcs8("-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----")).toThrow(
      /base64/,
    );
  });
});

describe("C4 regression: the private key is not stealable", () => {
  it("imports the key as non-extractable", async () => {
    const key = await importSigningKey(pem);
    expect(key.extractable).toBe(false);
    expect(key.type).toBe("private");
    expect(key.usages).toEqual(["sign"]);
  });

  it("can still sign — so the user never has to log in again", async () => {
    const key = await importSigningKey(pem);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode("payload"),
    );
    expect(signature.byteLength).toBe(256);
  });

  it("cannot be exported back out, unlike the old localStorage PEM", async () => {
    const key = await importSigningKey(pem);
    await expect(crypto.subtle.exportKey("pkcs8", key)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", key)).rejects.toThrow();
  });

  it("survives structuredClone, which is how IndexedDB persists it", async () => {
    const key = await importSigningKey(pem);
    const cloned = structuredClone(key);
    expect(cloned.extractable).toBe(false);
    // Still usable after the round-trip — no re-login on the next visit.
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cloned, new Uint8Array([1, 2, 3]));
    expect(signature.byteLength).toBe(256);
  });

  it("rejects a malformed key with a helpful message", async () => {
    await expect(importSigningKey("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----")).rejects.toThrow(
      CredentialError,
    );
  });
});

describe("credential storage", () => {
  it("stores the CryptoKey and never the PEM text", async () => {
    await saveCredentials({ serviceAccount, spreadsheetId: VALID_SHEET_ID }, database);
    const stored = await loadCredentials(database);

    expect(stored!.clientEmail).toBe(serviceAccount.client_email);
    expect(stored!.spreadsheetId).toBe(VALID_SHEET_ID);
    expect(stored!.privateKey.extractable).toBe(false);

    // The PEM must appear nowhere in the persisted record.
    const serialisable = { ...stored, privateKey: "[CryptoKey]" };
    expect(JSON.stringify(serialisable)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(serialisable)).not.toContain(pem.slice(40, 80));
  });

  it("persists across a simulated reload, with no re-login", async () => {
    await saveCredentials({ serviceAccount, spreadsheetId: VALID_SHEET_ID }, database);
    database.close();

    const reopened = new FocusLogDb(database.name);
    await reopened.open();
    const stored = await reopened.credentials.get("default");

    expect(stored).toBeDefined();
    expect(stored!.privateKey.extractable).toBe(false);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      stored!.privateKey,
      new Uint8Array([9]),
    );
    expect(signature.byteLength).toBe(256);
  });

  it("rejects an invalid spreadsheet id before storing anything", async () => {
    await expect(
      saveCredentials({ serviceAccount, spreadsheetId: "../evil" }, database),
    ).rejects.toThrow(/spreadsheet ID/);
    expect(await hasCredentials(database)).toBe(false);
  });

  it("clears credentials on request", async () => {
    await saveCredentials({ serviceAccount, spreadsheetId: VALID_SHEET_ID }, database);
    expect(await hasCredentials(database)).toBe(true);
    await clearCredentials(database);
    expect(await hasCredentials(database)).toBe(false);
  });
});

describe("createAssertion", () => {
  it("builds a signed RS256 JWT with the right claims", async () => {
    const key = await importSigningKey(pem);
    const jwt = await createAssertion("svc@test.iam.gserviceaccount.com", key, 1_800_000_000);

    const [header, claims, signature] = jwt.split(".");
    expect(header).toBeDefined();
    expect(signature).toBeDefined();

    const decode = (segment: string) =>
      JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(segment.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));

    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims!)).toEqual({
      iss: "svc@test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
  });

  it("produces base64url output with no padding", async () => {
    const key = await importSigningKey(pem);
    const jwt = await createAssertion("svc@test.iam.gserviceaccount.com", key, 1_800_000_000);
    expect(jwt).not.toContain("=");
    expect(jwt).not.toContain("+");
    expect(jwt).not.toContain("/");
  });
});

describe("C17 regression: token caching", () => {
  const tokenResponse = (token: string, expiresIn = 3600) =>
    new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("mints once and reuses the cached token", async () => {
    // The old code minted a fresh JWT — RSA sign plus a token exchange — on
    // every API call, so loading the home page did it three times.
    const key = await importSigningKey(pem);
    const fetchImpl = vi.fn<typeof fetch>(async () => tokenResponse("token-1"));
    const provider = new ServiceAccountTokenProvider({
      clientEmail: "svc@test.iam.gserviceaccount.com",
      privateKey: key,
      fetchImpl,
      now: () => 1_800_000_000_000,
    });

    for (let i = 0; i < 10; i += 1) expect(await provider.getAccessToken()).toBe("token-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of concurrent misses into one exchange", async () => {
    const key = await importSigningKey(pem);
    const fetchImpl = vi.fn<typeof fetch>(async () => tokenResponse("token-1"));
    const provider = new ServiceAccountTokenProvider({
      clientEmail: "svc@test.iam.gserviceaccount.com",
      privateKey: key,
      fetchImpl,
      now: () => 1_800_000_000_000,
    });

    const tokens = await Promise.all(Array.from({ length: 8 }, () => provider.getAccessToken()));
    expect(new Set(tokens)).toEqual(new Set(["token-1"]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes before expiry rather than after", async () => {
    const key = await importSigningKey(pem);
    let clock = 1_800_000_000_000;
    let issued = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => tokenResponse(`token-${++issued}`, 3600));
    const provider = new ServiceAccountTokenProvider({
      clientEmail: "svc@test.iam.gserviceaccount.com",
      privateKey: key,
      fetchImpl,
      now: () => clock,
    });

    expect(await provider.getAccessToken()).toBe("token-1");
    clock += 50 * 60 * 1000; // 50 min: still inside the 5-min safety margin
    expect(await provider.getAccessToken()).toBe("token-1");
    clock += 6 * 60 * 1000; // 56 min: now within 5 min of expiry
    expect(await provider.getAccessToken()).toBe("token-2");
  });

  it("re-mints after invalidate(), which the client calls on a 401", async () => {
    const key = await importSigningKey(pem);
    let issued = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => tokenResponse(`token-${++issued}`));
    const provider = new ServiceAccountTokenProvider({
      clientEmail: "svc@test.iam.gserviceaccount.com",
      privateKey: key,
      fetchImpl,
      now: () => 1_800_000_000_000,
    });

    expect(await provider.getAccessToken()).toBe("token-1");
    provider.invalidate();
    expect(await provider.getAccessToken()).toBe("token-2");
  });

  it("reports a revoked key in terms the user can act on", async () => {
    const key = await importSigningKey(pem);
    const provider = new ServiceAccountTokenProvider({
      clientEmail: "svc@test.iam.gserviceaccount.com",
      privateKey: key,
      fetchImpl: async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    });
    await expect(provider.getAccessToken()).rejects.toThrow(/revoked or deleted/);
  });

  it("reports a network failure distinctly from a rejection", async () => {
    const key = await importSigningKey(pem);
    const provider = new ServiceAccountTokenProvider({
      clientEmail: "svc@test.iam.gserviceaccount.com",
      privateKey: key,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(provider.getAccessToken()).rejects.toThrow(/Could not reach Google/);
  });

  it("errors when Google returns no token", async () => {
    const key = await importSigningKey(pem);
    const provider = new ServiceAccountTokenProvider({
      clientEmail: "svc@test.iam.gserviceaccount.com",
      privateKey: key,
      fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(provider.getAccessToken()).rejects.toThrow(/no access token/);
  });
});
