import { describe, expect, it } from "vitest";
import {
  durationSeconds,
  formatDuration,
  formatTotal,
  isIsoUtc,
  isLocalDate,
  localDateOf,
  localDatesBetween,
  toIsoUtc,
} from "./time";

describe("localDateOf", () => {
  it("returns the calendar date as experienced in the given zone", () => {
    // 2026-07-29T18:30:00Z is already the 30th in Singapore (+08:00).
    const instant = new Date("2026-07-29T18:30:00Z");
    expect(localDateOf(instant, "UTC")).toBe("2026-07-29");
    expect(localDateOf(instant, "Asia/Singapore")).toBe("2026-07-30");
    expect(localDateOf(instant, "America/Los_Angeles")).toBe("2026-07-29");
  });

  it("C10 regression: the same instant yields different dates across zones, so the zone must be stored", () => {
    // A session logged at 23:30 in Singapore belongs to that Singapore day.
    // Reading it back in UTC would move it to the previous day — which is
    // exactly the silent history shift the old MM/DD/YYYY format caused.
    const instant = new Date("2026-03-14T15:30:00Z"); // 23:30 SGT
    expect(localDateOf(instant, "Asia/Singapore")).toBe("2026-03-14");
    expect(localDateOf(instant, "UTC")).toBe("2026-03-14");

    const later = new Date("2026-03-14T16:30:00Z"); // 00:30 SGT next day
    expect(localDateOf(later, "Asia/Singapore")).toBe("2026-03-15");
    expect(localDateOf(later, "UTC")).toBe("2026-03-14");
  });

  it("handles a US spring-forward DST boundary", () => {
    // 2026-03-08 02:00 local is when US DST starts; 09:30Z is 01:30 PST.
    expect(localDateOf(new Date("2026-03-08T09:30:00Z"), "America/Los_Angeles")).toBe("2026-03-08");
    // 10:30Z is 03:30 PDT (02:xx never happens locally).
    expect(localDateOf(new Date("2026-03-08T10:30:00Z"), "America/Los_Angeles")).toBe("2026-03-08");
  });

  it("handles a zone with a non-hour offset", () => {
    // Kathmandu is UTC+05:45.
    expect(localDateOf(new Date("2026-07-29T18:20:00Z"), "Asia/Kathmandu")).toBe("2026-07-30");
    expect(localDateOf(new Date("2026-07-29T18:10:00Z"), "Asia/Kathmandu")).toBe("2026-07-29");
  });
});

describe("durationSeconds", () => {
  it("C6 regression: keeps whole seconds instead of truncating to minutes", () => {
    const start = new Date("2026-07-29T10:00:00Z");
    const end = new Date("2026-07-29T10:25:59Z"); // 25m59s
    // The old code did Math.floor(1559/60) = 25 minutes, losing 59s.
    expect(durationSeconds(start, end)).toBe(1559);
  });

  it("C7 regression: a sub-minute session has a real non-zero duration", () => {
    const start = new Date("2026-07-29T10:00:00Z");
    expect(durationSeconds(start, new Date("2026-07-29T10:00:50Z"))).toBe(50);
  });

  it("is unaffected by DST because both instants are absolute", () => {
    // Spans the US spring-forward: wall clock jumps 01:59 -> 03:00, but only
    // one real hour passes.
    const start = new Date("2026-03-08T09:30:00Z");
    const end = new Date("2026-03-08T10:30:00Z");
    expect(durationSeconds(start, end)).toBe(3600);
  });

  it("rejects invalid dates rather than producing NaN", () => {
    expect(() => durationSeconds(new Date("nope"), new Date())).toThrow(RangeError);
  });
});

describe("formatDuration", () => {
  it("C15 regression: rolls into hours instead of showing 122:05", () => {
    expect(formatDuration(7325)).toBe("2:02:05");
    expect(formatDuration(3600)).toBe("1:00:00");
  });

  it("uses M:SS below an hour", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(59)).toBe("0:59");
    expect(formatDuration(1559)).toBe("25:59");
  });
});

describe("formatTotal", () => {
  it("formats human totals", () => {
    expect(formatTotal(0)).toBe("0m");
    expect(formatTotal(30)).toBe("<1m");
    expect(formatTotal(600)).toBe("10m");
    expect(formatTotal(3600)).toBe("1h");
    expect(formatTotal(7500)).toBe("2h 5m");
  });

  it("never renders 60 minutes as a remainder", () => {
    // 3570s rounds to 60 minutes; splitting before rounding would give "1h 60m".
    expect(formatTotal(3570)).toBe("1h");
    expect(formatTotal(7170)).toBe("2h");
  });
});

describe("guards and serialisation", () => {
  it("round-trips an instant through ISO UTC", () => {
    const d = new Date("2026-07-29T06:30:00.123Z");
    const iso = toIsoUtc(d);
    expect(iso).toBe("2026-07-29T06:30:00.123Z");
    expect(isIsoUtc(iso)).toBe(true);
    expect(new Date(iso).getTime()).toBe(d.getTime());
  });

  it("rejects the old ambiguous format", () => {
    // This is what the old app wrote. It must not validate as a stored instant.
    expect(isIsoUtc("01/15/2025 14:30:00")).toBe(false);
    expect(isIsoUtc("2026-07-29T06:30:00")).toBe(false); // no zone
    expect(isIsoUtc("2026-07-29T06:30:00+08:00")).toBe(false); // not normalised to UTC
  });

  it("validates local dates", () => {
    expect(isLocalDate("2026-07-29")).toBe(true);
    expect(isLocalDate("2026-7-9")).toBe(false);
    expect(isLocalDate("29/07/2026")).toBe(false);
  });

  it("throws on serialising an Invalid Date", () => {
    expect(() => toIsoUtc(new Date("nope"))).toThrow(RangeError);
  });
});

describe("localDatesBetween", () => {
  it("lists every local date a range touches", () => {
    const start = new Date("2026-07-29T15:00:00Z"); // 23:00 SGT on the 29th
    const end = new Date("2026-07-29T17:00:00Z"); // 01:00 SGT on the 30th
    expect(localDatesBetween(start, end, "Asia/Singapore")).toEqual(["2026-07-29", "2026-07-30"]);
  });

  it("returns a single date for a same-day range", () => {
    const start = new Date("2026-07-29T02:00:00Z");
    const end = new Date("2026-07-29T03:00:00Z");
    expect(localDatesBetween(start, end, "UTC")).toEqual(["2026-07-29"]);
  });

  it("does not skip a date across a DST-shortened day", () => {
    const start = new Date("2026-03-08T05:00:00Z");
    const end = new Date("2026-03-10T05:00:00Z");
    expect(localDatesBetween(start, end, "America/Los_Angeles")).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
  });
});
