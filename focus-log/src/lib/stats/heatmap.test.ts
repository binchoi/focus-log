import { describe, expect, it } from "vitest";
import { addDays, buildHeatmap, currentStreak, levelFor, startOfWeek } from "./heatmap";

describe("addDays", () => {
  it("moves forward and backward across month and year boundaries", () => {
    expect(addDays("2026-07-29", 1)).toBe("2026-07-30");
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29"); // leap year
  });
});

describe("levelFor", () => {
  it("scales to the busiest day rather than to fixed thresholds", () => {
    // A user doing 20-minute sessions and one doing 3-hour sessions both get a
    // readable spread.
    expect(levelFor(0, 3600)).toBe(0);
    expect(levelFor(900, 3600)).toBe(1);
    expect(levelFor(1800, 3600)).toBe(2);
    expect(levelFor(2700, 3600)).toBe(3);
    expect(levelFor(3600, 3600)).toBe(4);
  });

  it("handles an empty dataset without dividing by zero", () => {
    expect(levelFor(0, 0)).toBe(0);
    expect(levelFor(100, 0)).toBe(0);
  });
});

describe("buildHeatmap", () => {
  const base = {
    from: "2026-07-01",
    to: "2026-07-31",
    today: "2026-07-29",
    secondsByDate: new Map<string, number>(),
  };

  it("C regression: every row is a fixed weekday", () => {
    // The old grid positioned by array index, so row 0 was whatever weekday the
    // range began on — Tuesday for Q3 2025, Wednesday for Q4 2025. Here row 0 is
    // always Monday.
    for (const from of ["2026-07-01", "2026-10-01", "2026-01-01", "2026-04-01"]) {
      const layout = buildHeatmap({ ...base, from, to: addDays(from, 90) });
      for (const cell of layout.cells) {
        const utcDay = new Date(`${cell.date}T00:00:00.000Z`).getUTCDay();
        expect(cell.weekday).toBe((utcDay + 6) % 7);
      }
      // The first cell is always a Monday, whatever date the range starts on.
      expect(layout.cells[0]!.weekday).toBe(0);
    }
  });

  it("makes each column exactly one calendar week", () => {
    const layout = buildHeatmap({ ...base, from: "2026-07-01", to: "2026-07-28" });
    const byWeek = new Map<number, string[]>();
    for (const cell of layout.cells) {
      byWeek.set(cell.week, [...(byWeek.get(cell.week) ?? []), cell.date]);
    }
    // Every complete column holds 7 consecutive days starting on a Monday.
    for (const [, dates] of byWeek) {
      if (dates.length !== 7) continue;
      expect(new Date(`${dates[0]}T00:00:00.000Z`).getUTCDay()).toBe(1); // Monday
      for (let i = 1; i < dates.length; i += 1) {
        expect(dates[i]).toBe(addDays(dates[i - 1]!, 1));
      }
    }
  });

  it("snaps the start back to Monday so the first week is not ragged", () => {
    // 2026-07-01 is a Wednesday; the grid starts on Monday 2026-06-29.
    const layout = buildHeatmap({ ...base, from: "2026-07-01", to: "2026-07-07" });
    expect(layout.cells[0]!.date).toBe("2026-06-29");
  });

  it("scales intensity by minutes, not by session count", () => {
    // The old grid incremented by 1 per session, so a 4-hour block and a
    // 4-minute one were indistinguishable.
    const secondsByDate = new Map([
      ["2026-07-06", 4 * 3600], // one long session
      ["2026-07-07", 4 * 60], // one short session
    ]);
    const layout = buildHeatmap({ ...base, secondsByDate });

    const long = layout.cells.find((c) => c.date === "2026-07-06")!;
    const short = layout.cells.find((c) => c.date === "2026-07-07")!;
    expect(long.level).toBeGreaterThan(short.level);
    expect(long.level).toBe(4);
    expect(short.level).toBe(1);
  });

  it("marks future days so they can be dimmed", () => {
    const layout = buildHeatmap({ ...base, today: "2026-07-15" });
    expect(layout.cells.find((c) => c.date === "2026-07-14")!.isFuture).toBe(false);
    expect(layout.cells.find((c) => c.date === "2026-07-15")!.isFuture).toBe(false);
    expect(layout.cells.find((c) => c.date === "2026-07-16")!.isFuture).toBe(true);
  });

  it("emits a month label once per month, at the right column", () => {
    const layout = buildHeatmap({ ...base, from: "2026-06-01", to: "2026-08-31" });
    const labels = layout.monthLabels.map((m) => m.label);
    expect(labels).toEqual(["Jun", "Jul", "Aug"]);
    // Labels are strictly ordered by column.
    const weeks = layout.monthLabels.map((m) => m.week);
    expect([...weeks].sort((a, b) => a - b)).toEqual(weeks);
  });

  it("suppresses a month label that would collide with the previous one", () => {
    // The Monday snap-back can put two month starts one column apart, which
    // rendered as "MarApr" overlapping in the same place.
    const layout = buildHeatmap({ ...base, from: "2026-03-30", to: "2026-08-31" });
    const weeks = layout.monthLabels.map((m) => m.week);
    for (let i = 1; i < weeks.length; i += 1) {
      expect(weeks[i]! - weeks[i - 1]!).toBeGreaterThanOrEqual(3);
    }
  });

  it("still labels a later month after suppressing a crowded one", () => {
    const layout = buildHeatmap({ ...base, from: "2026-03-30", to: "2026-08-31" });
    // Aug is far from Apr, so it must appear even if Apr was suppressed.
    expect(layout.monthLabels.map((m) => m.label)).toContain("Aug");
  });

  it("handles an empty range without throwing", () => {
    const layout = buildHeatmap({ ...base, from: "2026-07-10", to: "2026-07-01" });
    expect(layout.weeks).toBe(0);
    expect(layout.cells).toEqual([]);
  });

  it("reports the busiest day", () => {
    const layout = buildHeatmap({
      ...base,
      secondsByDate: new Map([
        ["2026-07-06", 1800],
        ["2026-07-07", 7200],
      ]),
    });
    expect(layout.maxSeconds).toBe(7200);
  });
});

describe("startOfWeek", () => {
  it("returns the Monday of the containing week", () => {
    // 2026-07-29 is a Wednesday.
    expect(startOfWeek("2026-07-29")).toBe("2026-07-27");
    // A Monday is its own week start.
    expect(startOfWeek("2026-07-27")).toBe("2026-07-27");
    // A Sunday belongs to the week that began six days earlier, not the next one.
    expect(startOfWeek("2026-08-02")).toBe("2026-07-27");
  });

  it("crosses a month and a year boundary", () => {
    expect(startOfWeek("2026-08-01")).toBe("2026-07-27");
    expect(startOfWeek("2026-01-01")).toBe("2025-12-29");
  });
});

describe("currentStreak", () => {
  it("counts consecutive logged days ending today", () => {
    const secondsByDate = new Map([
      ["2026-07-27", 1800],
      ["2026-07-28", 1800],
      ["2026-07-29", 1800],
    ]);
    expect(currentStreak(secondsByDate, "2026-07-29")).toBe(3);
  });

  it("survives a today that has not been logged yet", () => {
    // Mid-morning, before any focus — yesterday's streak should still show.
    const secondsByDate = new Map([
      ["2026-07-27", 1800],
      ["2026-07-28", 1800],
    ]);
    expect(currentStreak(secondsByDate, "2026-07-29")).toBe(2);
  });

  it("breaks on a gap", () => {
    const secondsByDate = new Map([
      ["2026-07-25", 1800],
      ["2026-07-28", 1800],
      ["2026-07-29", 1800],
    ]);
    expect(currentStreak(secondsByDate, "2026-07-29")).toBe(2);
  });

  it("is zero with no data, and ignores zero-second days", () => {
    expect(currentStreak(new Map(), "2026-07-29")).toBe(0);
    expect(currentStreak(new Map([["2026-07-29", 0]]), "2026-07-29")).toBe(0);
  });
});
