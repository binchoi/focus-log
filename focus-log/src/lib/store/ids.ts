/**
 * Identity helpers.
 *
 * Ids are minted on the client *before* any network call. That is what makes
 * the append-only sync idempotent: if a write succeeds but the response is
 * lost, the retry appends a row with the same id and the reducer collapses it
 * (see src/lib/sync/merge.ts). Letting the server assign ids would make a
 * retried write indistinguishable from a new record.
 */

/** RFC 4122 v4 uuid, using the platform CSPRNG. */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older Safari: getRandomValues is far more widely available
  // than randomUUID.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

const DEVICE_ID_KEY = "focus-log.device_id";

/**
 * Stable per-browser identifier, used only as a deterministic tie-break when
 * two devices write the same record in the same millisecond. Not a secret and
 * not used for auth.
 */
export function getDeviceId(): string {
  if (typeof localStorage === "undefined") return "server";
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const fresh = `dev-${newId().slice(0, 8)}`;
  localStorage.setItem(DEVICE_ID_KEY, fresh);
  return fresh;
}
