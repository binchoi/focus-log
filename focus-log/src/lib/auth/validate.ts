/**
 * "Test connection" — validates a spreadsheet *before* anything is saved.
 *
 * The old app saved whatever you typed and then failed later, at random, with a
 * console error: a wrong id, an unshared sheet, or a missing tab all surfaced as
 * a permanently blank goal grid. Checking up front turns that whole class of
 * silent failure into one actionable message.
 */

import { SheetsClient, SheetsError } from "../sheets/client";
import {
  GOAL_COLUMNS,
  META_COLUMNS,
  RANGES,
  SCHEMA_VERSION,
  SESSION_COLUMNS,
  TAB_NAMES,
  headerRow,
  type ColumnDef,
  type Row,
} from "../sheets/columns";
import { parseMetaRows } from "../sheets/schema";
import { toStringCell } from "../sheets/cells";

export type CheckStatus = "ok" | "warning" | "error";

export interface ValidationCheck {
  label: string;
  status: CheckStatus;
  detail: string;
  /** What the user should do about it. */
  fix?: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: ValidationCheck[];
}

function compareHeader(
  tab: string,
  expected: readonly ColumnDef[],
  actual: Row | undefined,
): ValidationCheck {
  const want = headerRow(expected);
  const got = (actual ?? []).map((cell) => toStringCell(cell));

  if (got.length === 0) {
    return {
      label: `Tab "${tab}" header`,
      status: "error",
      detail: "The tab is empty.",
      fix: `Import ${tab}.csv from the sheet-template folder into cell A1.`,
    };
  }

  const mismatches: string[] = [];
  want.forEach((name, index) => {
    if (got[index] !== name) {
      mismatches.push(
        `column ${String.fromCharCode(65 + index)} should be "${name}", found "${got[index] ?? "(empty)"}"`,
      );
    }
  });

  if (mismatches.length > 0) {
    return {
      label: `Tab "${tab}" header`,
      status: "error",
      detail: mismatches.slice(0, 4).join("; "),
      fix: `Re-import ${tab}.csv from the sheet-template folder, replacing data at cell A1.`,
    };
  }

  if (got.length > want.length) {
    return {
      label: `Tab "${tab}" header`,
      status: "warning",
      detail: `Found ${got.length - want.length} extra column(s) after "${want[want.length - 1]}". They will be ignored.`,
    };
  }

  return {
    label: `Tab "${tab}" header`,
    status: "ok",
    detail: `All ${want.length} columns correct.`,
  };
}

/**
 * Runs every check. Never throws for an expected failure — a failed connection
 * test is a normal outcome the UI renders, not an exception.
 */
export async function validateConnection(client: SheetsClient): Promise<ValidationReport> {
  const checks: ValidationCheck[] = [];

  // 1. Can we reach the spreadsheet at all, with these credentials?
  let tabs: string[];
  try {
    tabs = await client.listTabs();
    checks.push({
      label: "Spreadsheet access",
      status: "ok",
      detail: `Connected. Found ${tabs.length} tab(s).`,
    });
  } catch (error) {
    const sheetsError = error instanceof SheetsError ? error : undefined;
    checks.push({
      label: "Spreadsheet access",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      fix:
        sheetsError?.kind === "permission"
          ? "Share the spreadsheet with your service account's client_email, as an Editor."
          : sheetsError?.kind === "not_found"
            ? "Check the spreadsheet ID — copy the string between /d/ and /edit in its URL."
            : sheetsError?.kind === "auth"
              ? "The service account key was rejected. It may have been revoked; generate a new one."
              : "Check your internet connection and try again.",
    });
    return { ok: false, checks };
  }

  // 2. Do the three tabs exist?
  const required = [TAB_NAMES.goals, TAB_NAMES.sessions, TAB_NAMES.meta];
  const missing = required.filter((tab) => !tabs.includes(tab));
  checks.push(
    missing.length === 0
      ? { label: "Required tabs", status: "ok", detail: `Found ${required.join(", ")}.` }
      : {
          label: "Required tabs",
          status: "error",
          detail: `Missing: ${missing.join(", ")}. Found: ${tabs.join(", ") || "none"}.`,
          fix: "Create the missing tab(s) with exactly these lowercase names, then import the matching CSV.",
        },
  );
  if (missing.length > 0) return { ok: false, checks };

  // 3. Do the headers match what the app reads and writes?
  let values: Map<string, Row[]>;
  try {
    values = await client.batchGet([RANGES.goals, RANGES.sessions, RANGES.meta]);
  } catch (error) {
    checks.push({
      label: "Reading tabs",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Try again — this looks like a temporary problem.",
    });
    return { ok: false, checks };
  }

  checks.push(compareHeader(TAB_NAMES.goals, GOAL_COLUMNS, (values.get(RANGES.goals) ?? [])[0]));
  checks.push(
    compareHeader(TAB_NAMES.sessions, SESSION_COLUMNS, (values.get(RANGES.sessions) ?? [])[0]),
  );
  checks.push(compareHeader(TAB_NAMES.meta, META_COLUMNS, (values.get(RANGES.meta) ?? [])[0]));

  // 4. Schema version.
  const meta = parseMetaRows(values.get(RANGES.meta) ?? []);
  const version = Number(meta.schema_version);
  if (!Number.isFinite(version)) {
    checks.push({
      label: "Schema version",
      status: "warning",
      detail: "No schema_version row found in the meta tab. Assuming the current version.",
      fix: "Import meta.csv to add it.",
    });
  } else if (version > SCHEMA_VERSION) {
    checks.push({
      label: "Schema version",
      status: "error",
      // Writing to a newer sheet risks dropping columns this build doesn't know about.
      detail: `This spreadsheet uses schema version ${version}, but this version of focus-log only understands ${SCHEMA_VERSION}.`,
      fix: "Update focus-log before using this spreadsheet.",
    });
  } else if (version < SCHEMA_VERSION) {
    // An older sheet still works — the app just leaves newer, additive features
    // (the `active` tab / cross-device timer) off until it is migrated. So this
    // is a warning, not a blocker.
    checks.push({
      label: "Schema version",
      status: "warning",
      detail: `This spreadsheet uses schema version ${version}; the app is on ${SCHEMA_VERSION}. It works as-is, but newer features stay disabled.`,
      fix: "Re-import the CSV template (adds the `active` tab) to enable the cross-device timer.",
    });
  } else {
    checks.push({ label: "Schema version", status: "ok", detail: `Version ${version}.` });
  }

  // 5. Can we write? Verified by reading, not by writing a probe row — a probe
  // would leave junk in the user's sheet, and 403 on read already implies no write.
  const goalRows = (values.get(RANGES.goals) ?? []).length;
  const sessionRows = (values.get(RANGES.sessions) ?? []).length;
  checks.push({
    label: "Existing data",
    status: "ok",
    detail:
      goalRows <= 1 && sessionRows <= 1
        ? "Empty spreadsheet, ready to use."
        : `Found ${Math.max(0, goalRows - 1)} goal row(s) and ${Math.max(0, sessionRows - 1)} session row(s).`,
  });

  return { ok: !checks.some((c) => c.status === "error"), checks };
}
