import { afterEach, describe, expect, it, vi } from "vitest";
import { getDeviceId, newId } from "./ids";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("newId", () => {
  it("uses crypto.randomUUID when available", () => {
    expect(newId()).toMatch(UUID_V4);
  });

  it("falls back to getRandomValues on platforms without randomUUID", () => {
    // Older Safari ships getRandomValues but not randomUUID. The fallback must
    // still produce a well-formed v4 uuid, since ids are what make sync
    // idempotent — a malformed one would fail schema validation on write.
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      subtle: realCrypto.subtle,
    });

    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it("sets the version and variant bits correctly in the fallback", () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      // All-zero bytes: only the version/variant nibbles should be non-zero.
      getRandomValues: (buffer: Uint8Array) => buffer.fill(0),
      subtle: realCrypto.subtle,
    });
    expect(newId()).toBe("00000000-0000-4000-8000-000000000000");
  });
});

describe("getDeviceId", () => {
  it("returns a stable id across calls", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });

    const first = getDeviceId();
    expect(first).toMatch(/^dev-[0-9a-f]{8}$/);
    expect(getDeviceId()).toBe(first);
    expect(getDeviceId()).toBe(first);
  });

  it("gives two browsers different ids, so the LWW tie-break works", () => {
    const browserA = new Map<string, string>();
    const browserB = new Map<string, string>();
    const use = (store: Map<string, string>) =>
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      });

    use(browserA);
    const idA = getDeviceId();
    use(browserB);
    const idB = getDeviceId();

    expect(idA).not.toBe(idB);
  });

  it("degrades to a fixed value where localStorage is absent (SSR)", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(getDeviceId()).toBe("server");
  });
});
