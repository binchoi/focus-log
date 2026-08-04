/**
 * Guards the checked-in CSV template against column drift.
 *
 * The user imports these CSVs into Google Sheets by hand, so a column change
 * that isn't reflected in the template silently breaks a real spreadsheet.
 * This test fails until `npm run sheet:template` is re-run.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_COLUMNS,
  GOAL_COLUMNS,
  META_COLUMNS,
  SCHEMA_VERSION,
  SESSION_COLUMNS,
  headerRow,
} from "./columns";

const templateDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "sheet-template",
);

function firstLine(file: string): string {
  return readFileSync(join(templateDir, file), "utf8").split("\n")[0]!;
}

describe("sheet template", () => {
  it("goals.csv header matches the column definitions", () => {
    expect(firstLine("goals.csv")).toBe(headerRow(GOAL_COLUMNS).join(","));
  });

  it("sessions.csv header matches the column definitions", () => {
    expect(firstLine("sessions.csv")).toBe(headerRow(SESSION_COLUMNS).join(","));
  });

  it("active.csv header matches the column definitions", () => {
    expect(firstLine("active.csv")).toBe(headerRow(ACTIVE_COLUMNS).join(","));
  });

  it("meta.csv header matches and declares the current schema version", () => {
    const contents = readFileSync(join(templateDir, "meta.csv"), "utf8");
    expect(contents.split("\n")[0]).toBe(headerRow(META_COLUMNS).join(","));
    expect(contents).toContain(`schema_version,${SCHEMA_VERSION}`);
  });

  it("ships goals, sessions and active with only a header row", () => {
    // Any seeded data would end up in the user's real spreadsheet.
    for (const file of ["goals.csv", "sessions.csv", "active.csv"]) {
      const lines = readFileSync(join(templateDir, file), "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
    }
  });

  it("SETUP.md documents every column", () => {
    const setup = readFileSync(join(templateDir, "SETUP.md"), "utf8");
    for (const column of [
      ...GOAL_COLUMNS,
      ...SESSION_COLUMNS,
      ...META_COLUMNS,
      ...ACTIVE_COLUMNS,
    ]) {
      expect(setup).toContain(`\`${column.key}\``);
    }
  });
});
