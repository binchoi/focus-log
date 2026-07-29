/**
 * Generates the CSV files you import into Google Sheets, plus SETUP.md.
 *
 * Run with:  npm run sheet:template
 *
 * The CSVs are derived from src/lib/sheets/columns.ts so the template can never
 * drift from what the app reads and writes. `sheet-template.test.ts` asserts
 * the checked-in files still match, so a column change fails CI until the
 * template is regenerated.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GOAL_COLUMNS,
  META_COLUMNS,
  SCHEMA_VERSION,
  SESSION_COLUMNS,
  TAB_NAMES,
  fullRange,
  headerRow,
  type ColumnDef,
} from "../src/lib/sheets/columns.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "sheet-template");

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvFor(columns: readonly ColumnDef[], rows: string[][] = []): string {
  return [headerRow(columns), ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export function metaCsv(): string {
  return csvFor(META_COLUMNS, [
    ["schema_version", String(SCHEMA_VERSION)],
    ["created_by", "focus-log"],
  ]);
}

function columnTable(columns: readonly ColumnDef[]): string {
  const rows = columns.map((c, i) => {
    const letter = String.fromCharCode(65 + i);
    return `| ${letter} | \`${c.key}\` | ${c.type} | ${c.note ?? ""} |`;
  });
  return ["| col | field | type | notes |", "|---|---|---|---|", ...rows].join("\n");
}

const setup = `# Setting up your focus-log spreadsheet

This creates the spreadsheet focus-log reads and writes. It takes about 5 minutes.
You only do it once.

## 1. Create the spreadsheet

1. Go to [sheets.new](https://sheets.new) to create an empty spreadsheet.
2. Name it something like \`focus-log\`.
3. Copy its ID from the URL — the long string between \`/d/\` and \`/edit\`:
   \`https://docs.google.com/spreadsheets/d/\` **\`<THIS PART>\`** \`/edit\`

## 2. Create the three tabs

You need exactly three tabs, named **\`${TAB_NAMES.goals}\`**, **\`${TAB_NAMES.sessions}\`** and
**\`${TAB_NAMES.meta}\`** (lowercase).

For each one:

1. Create the tab and rename it (double-click the tab at the bottom).
2. Select cell **A1**.
3. **File → Import** → *Upload* the matching CSV from this folder.
4. Set **Import location** to *Replace data at selected cell*, then *Import data*.

| Tab | File | Range the app uses |
|---|---|---|
| \`${TAB_NAMES.goals}\` | \`goals.csv\` | \`${fullRange(TAB_NAMES.goals, GOAL_COLUMNS)}\` |
| \`${TAB_NAMES.sessions}\` | \`sessions.csv\` | \`${fullRange(TAB_NAMES.sessions, SESSION_COLUMNS)}\` |
| \`${TAB_NAMES.meta}\` | \`meta.csv\` | \`${fullRange(TAB_NAMES.meta, META_COLUMNS)}\` |

Delete the default \`Sheet1\` tab once the three exist.

> The \`goals\` and \`sessions\` tabs contain only a header row. That is correct —
> the app creates your goals and sessions itself. You never need to type into
> the sheet.

## 3. Give the service account access

1. Open the service account JSON you use for focus-log and find \`client_email\`
   (it looks like \`something@your-project.iam.gserviceaccount.com\`).
2. In the spreadsheet, click **Share**, paste that email, give it **Editor**,
   and untick "Notify people".

## 4. Connect the app

Open focus-log, go to **/setup**, paste the service account JSON and the
spreadsheet ID, then press **Test connection**. It verifies every tab and column
header before saving anything, so a typo is caught here rather than silently
losing data later.

---

## How the data is stored

The sheet is an **append-only log**. The app never edits or deletes a row:

- Editing a session appends a new row with the same \`log_id\` and a newer \`updated_at\`.
- Deleting a session appends a row with \`deleted = TRUE\` (a tombstone).
- On read, the app keeps the newest row per \`log_id\`.

This is what makes offline use safe. If a write succeeds but the reply is lost,
retrying appends an identical row and the app de-duplicates it — so a flaky
connection can never create a duplicate or lose a session. It also means you can
insert or delete rows by hand without breaking anything, because the app never
addresses rows by position.

Consequence: you will see multiple rows per session if you edit one. Settings →
**Compact sheet** rewrites the tab keeping only the newest version of each row.

### \`${TAB_NAMES.goals}\`

${columnTable(GOAL_COLUMNS)}

### \`${TAB_NAMES.sessions}\`

${columnTable(SESSION_COLUMNS)}

### \`${TAB_NAMES.meta}\`

${columnTable(META_COLUMNS)}

## Optional: a human-readable summary tab

The app computes all its own totals and never reads this — it exists purely so
the spreadsheet stays browsable. Create a tab called \`summary\` and paste this
into **A1**:

\`\`\`
=QUERY({${TAB_NAMES.sessions}!B2:B, ${TAB_NAMES.sessions}!E2:E, ${TAB_NAMES.sessions}!K2:K},
  "select Col1, sum(Col2)/3600 where Col1 is not null and Col3 = false group by Col1 label sum(Col2)/3600 'hours'", 0)
\`\`\`

Because the log is append-only, this counts superseded rows too. Treat it as a
rough view; the app is the accurate one.
`;

function main(): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "goals.csv"), csvFor(GOAL_COLUMNS));
  writeFileSync(join(outDir, "sessions.csv"), csvFor(SESSION_COLUMNS));
  writeFileSync(join(outDir, "meta.csv"), metaCsv());
  writeFileSync(join(outDir, "SETUP.md"), setup);
  process.stdout.write(`Wrote sheet template to ${outDir}\n`);
}

main();
