# Setting up your focus-log spreadsheet

This creates the spreadsheet focus-log reads and writes. It takes about 5 minutes.
You only do it once.

## 1. Create the spreadsheet

1. Go to [sheets.new](https://sheets.new) to create an empty spreadsheet.
2. Name it something like `focus-log`.
3. Copy its ID from the URL — the long string between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/` **`<THIS PART>`** `/edit`

## 2. Create the four tabs

You need exactly four tabs, named **`goals`**, **`sessions`**,
**`meta`** and **`active`** (lowercase).

For each one:

1. Create the tab and rename it (double-click the tab at the bottom).
2. Select cell **A1**.
3. **File → Import** → *Upload* the matching CSV from this folder.
4. Set **Import location** to *Replace data at selected cell*, then *Import data*.

| Tab | File | Range the app uses |
|---|---|---|
| `goals` | `goals.csv` | `goals!A:J` |
| `sessions` | `sessions.csv` | `sessions!A:L` |
| `meta` | `meta.csv` | `meta!A:B` |
| `active` | `active.csv` | `active!A:G` |

Delete the default `Sheet1` tab once the four exist.

> **Already have a focus-log sheet from before the cross-device timer?** You only
> need to add the new bits — see [Migrating an existing sheet](#migrating-an-existing-sheet-v1--v2)
> at the bottom. Nothing you already have changes.

> The `goals` and `sessions` tabs contain only a header row. That is correct —
> the app creates your goals and sessions itself. You never need to type into
> the sheet.

## 3. Give the service account access

1. Open the service account JSON you use for focus-log and find `client_email`
   (it looks like `something@your-project.iam.gserviceaccount.com`).
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

- Editing a session appends a new row with the same `log_id` and a newer `updated_at`.
- Deleting a session appends a row with `deleted = TRUE` (a tombstone).
- On read, the app keeps the newest row per `log_id`.

This is what makes offline use safe. If a write succeeds but the reply is lost,
retrying appends an identical row and the app de-duplicates it — so a flaky
connection can never create a duplicate or lose a session. It also means you can
insert or delete rows by hand without breaking anything, because the app never
addresses rows by position.

Consequence: you will see multiple rows per session if you edit one. Settings →
**Compact sheet** rewrites the tab keeping only the newest version of each row.

### `goals`

| col | field | type | notes |
|---|---|---|---|
| A | `goal_id` | string | UUIDv4. Stable forever, never reused. |
| B | `title` | string |  |
| C | `color` | string | Hex colour used by the UI. |
| D | `weekly_target_minutes` | number | 0 means no target. |
| E | `sort_order` | number |  |
| F | `status` | string | active | archived |
| G | `created_at` | string | ISO-8601 UTC |
| H | `updated_at` | string | ISO-8601 UTC. The last-write-wins key. |
| I | `deleted` | boolean | Tombstone. TRUE hides the row. |
| J | `device_id` | string | Tie-breaker for identical updated_at. |

### `sessions`

| col | field | type | notes |
|---|---|---|---|
| A | `log_id` | string | UUIDv4 minted before the write, so retries are idempotent. |
| B | `goal_id` | string |  |
| C | `start_utc` | string | ISO-8601 UTC |
| D | `end_utc` | string | ISO-8601 UTC |
| E | `duration_seconds` | number | Computed by the app, not a sheet formula. |
| F | `local_date` | string | YYYY-MM-DD in the timezone at log time. |
| G | `tz` | string | IANA zone, e.g. Asia/Singapore. |
| H | `note` | string |  |
| I | `source` | string | timer | manual | import |
| J | `updated_at` | string | ISO-8601 UTC. The last-write-wins key. |
| K | `deleted` | boolean | Tombstone. |
| L | `device_id` | string | Tie-breaker for identical updated_at. |

### `meta`

| col | field | type | notes |
|---|---|---|---|
| A | `key` | string |  |
| B | `value` | string |  |

### `active`

The **shared running timer**. While a focus session is in progress, the device
running it writes one row here (keyed by `log_id`); other devices read it to show
"running since…" and can pause or stop it. When the session is stopped the row is
tombstoned (`deleted = TRUE`) and the finished session is appended to
`sessions` under the *same* `log_id`. It is normal for this tab to be
empty most of the time.

| col | field | type | notes |
|---|---|---|---|
| A | `log_id` | string | The session id, minted at start and reused at finalise. |
| B | `goal_id` | string |  |
| C | `segments` | string | Focus intervals as `startMs,endMs;…` (open segment ends blank). |
| D | `note` | string |  |
| E | `updated_at` | string | ISO-8601 UTC. The last-write-wins key. |
| F | `deleted` | boolean | Tombstone: TRUE once the timer is stopped or discarded. |
| G | `device_id` | string | The device the timer is running on; tie-breaker for identical updated_at. |

## Migrating an existing sheet (v1 → v2)

If you set up focus-log before the cross-device timer, your sheet has `goals`,
`sessions` and `meta` but no `active` tab. To enable the feature:

1. **Add the `active` tab**: create a tab named `active`,
   select **A1**, **File → Import** → upload `active.csv`, *Replace data at selected
   cell*.
2. **Bump the schema version**: on the `meta` tab, change the `schema_version`
   value from `1` to `2`.

That's it — no existing data changes. Until you do this the app keeps working
exactly as before; the timer just stays on one device. Repeat for each person's
spreadsheet (each user has their own).

## Optional: a human-readable summary tab

The app computes all its own totals and never reads this — it exists purely so
the spreadsheet stays browsable. Create a tab called `summary` and paste this
into **A1**:

```
=QUERY({sessions!B2:B, sessions!E2:E, sessions!K2:K},
  "select Col1, sum(Col2)/3600 where Col1 is not null and Col3 = false group by Col1 label sum(Col2)/3600 'hours'", 0)
```

Because the log is append-only, this counts superseded rows too. Treat it as a
rough view; the app is the accurate one.
