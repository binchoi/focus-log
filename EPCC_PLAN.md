# Plan: focus-log — no-server local-first PWA

**Created**: 2026-07-29 | **Branch**: `feat/modernize-pwa` | **Effort**: ~60h | **Complexity**: Complex
**Basis**: `EPCC_EXPLORE.md` (findings referenced as C1–C20)

**Decisions locked with you**
| Decision | Choice |
|---|---|
| Server | **None.** Static export to Vercel; browser talks to Sheets directly |
| Auth | **Never log out.** Convenience over hardening |
| Existing history | **Fresh start.** New sheet from my CSVs; old sheet kept as an untouched archive |
| Sequencing | **Part A (correctness) → your review → Part B (experience)** |
| Next.js | **Upgrade to 16.2.12** |
| Host | **Vercel** (HTTPS, installable PWA) |

---

## 1. Objective

**Goal**: Turn focus-log into a local-first PWA that never loses a session, computes everything itself, and lets you do every routine task — goal CRUD, editing logs, backfilling — without ever opening the spreadsheet.

**Why**: Today the app can only *append*. Derived values live in sheet formulas (C13), so the sheet is mandatory for anything real. And a failed network write destroys the session silently (C1).

**Success criteria** (all measurable):
1. Log a session with the network off, close the tab, reopen online → the session appears in the sheet. Zero loss.
2. Run a 30-minute timer in a background tab → logged duration is within 2s of wall clock (today it can be off by ~95%).
3. Create, rename, archive a goal; edit and delete a past session; backfill yesterday — all in-app.
4. Installable on desktop; full app shell loads with no network.
5. `npm run build`, `npm run lint`, `npm run typecheck`, `npm test` all pass in CI.

---

## 2. Approach

### 2.1 The core move: the sheet becomes an append-only event log

This is the decision everything else follows from, so it's worth being explicit.

**Today**: the app appends `A:C`; the sheet computes `duration` and the whole `summary` tab. The app cannot address, edit, or delete a row.

**Problem with the obvious fix** (`values.update` on a row range): updating in place needs a row index, and row indices shift the moment you manually insert or delete a row in the sheet. That's fragile and effectively unfixable offline.

**Chosen design — append-only + last-write-wins reduce**:
- Every write is a `values.append`. **Nothing is ever updated in place.**
- An edit appends a *new* row with the same `log_id` and a newer `updated_at`.
- A delete appends a row with `deleted=TRUE` (a tombstone).
- On read, the app reduces rows by `log_id`, keeping the highest `updated_at`.

Why this wins:
- **Idempotent retries.** If a write succeeds but the response is lost, retrying appends an identical `(log_id, updated_at)` row — the reducer dedupes it. This is what makes the offline queue safe.
- **Immune to manual sheet edits.** No row addressing at all.
- **Deterministic multi-device merge.** LWW on `updated_at`, ties broken by `device_id` lexicographically — every device converges on the same answer without a server.
- **Growth is a non-issue.** ~5 sessions/day ≈ 1,800 rows/year against Sheets' 10M-cell limit. A "Compact sheet" button in Settings rewrites latest-only if you ever want it tidy.

Trade-off accepted: the sheet is no longer hand-editable as a simple table. Mitigated by an optional read-only `summary` tab (one `ARRAYFORMULA`, purely for your eyes — **the app never reads it**), so the spreadsheet stays browsable.

### 2.2 New sheet schema (this is what the CSVs will create)

`valueInputOption=RAW` on write and `valueRenderOption=UNFORMATTED_VALUE` on read — the latter fixes C8, where `"1,234"` silently became `1`.

**Tab: `goals`**
| col | field | type | notes |
|---|---|---|---|
| A | `goal_id` | text | UUIDv4. Stable forever — never reused |
| B | `title` | text | |
| C | `color` | text | hex, for UI |
| D | `weekly_target_minutes` | number | 0 = no target |
| E | `sort_order` | number | dashboard ordering |
| F | `status` | text | `active` \| `archived` |
| G | `created_at` | text | ISO-8601 UTC |
| H | `updated_at` | text | ISO-8601 UTC — the LWW key |
| I | `deleted` | text | `TRUE`/`FALSE` tombstone |
| J | `device_id` | text | tiebreaker for simultaneous edits |

**Tab: `sessions`** (replaces `logs`)
| col | field | type | notes |
|---|---|---|---|
| A | `log_id` | text | UUIDv4 — generated **client-side before the write**, which is what makes retries idempotent |
| B | `goal_id` | text | FK to goals |
| C | `start_utc` | text | ISO-8601 with `Z`. Unambiguous (fixes C10) |
| D | `end_utc` | text | ISO-8601 with `Z` |
| E | `duration_seconds` | number | **app-computed** (fixes C6 truncation, C7 zero-rows, C13 formula dependency) |
| F | `local_date` | text | `YYYY-MM-DD` in the tz at log time. Makes streaks/heatmaps correct and sheet pivots easy |
| G | `tz` | text | IANA name, e.g. `Asia/Singapore`. Keeps history interpretable after you travel |
| H | `note` | text | optional |
| I | `source` | text | `timer` \| `manual` \| `import` |
| J | `updated_at` | text | LWW key |
| K | `deleted` | text | tombstone |
| L | `device_id` | text | tiebreaker |

**Tab: `meta`** — `key`/`value` rows: `schema_version` (starts at `1`), `created_by`, `created_at`. Lets the app detect an outdated sheet and tell you, rather than rendering garbage.

Storing **both** `start_utc` and (`local_date` + `tz`) is deliberate: UTC makes arithmetic correct, and the local date makes "what did I do on Tuesday" correct. Deriving one from the other after the fact is impossible once you've changed timezone — which is exactly bug C10.

**Deliverable**: `sheet-template/goals.csv`, `sessions.csv`, `meta.csv` + a `SETUP.md` with import steps and the optional `summary` formula.

### 2.3 Auth: keep "never log out", remove the stealable key

**Verified before planning this** — a non-extractable `CryptoKey` signs indefinitely but cannot be exported:
```
imported non-extractable, key.extractable = false
can still sign: 256 byte signature  ✓
exportKey blocked  ✓ -> InvalidAccessException: key is not extractable
structuredClone(CryptoKey) ✓   (so IndexedDB can persist it)
```

So: at setup, import the PEM with `extractable: false`, persist the resulting `CryptoKey` object in IndexedDB, and **discard the PEM text**. You never log out and never re-enter anything. But the private key is no longer sitting in `localStorage` in plaintext (C4), and no script can read it back out.

**Honest limit**: XSS on the page could still *use* the key to read/write your sheet while the page is open. It just can't steal a permanent credential to use later, offline, forever. That's a meaningful reduction, not elimination. Layering on top: a CSP restricting `connect-src` to `sheets.googleapis.com` and `oauth2.googleapis.com` (cheap, static, set via `next.config` headers).

Also here: cache the access token (memory + IndexedDB, refresh 5 min before expiry) instead of minting a fresh JWT per call — fixes C17's 3 signings per page load. And validate `spreadsheetId` against `^[a-zA-Z0-9-_]{20,60}$` with `encodeURIComponent`, closing the URL-injection gap.

### 2.4 Local-first data layer

IndexedDB via Dexie is the **source of truth for the UI**. The sheet is a sync target.

Tables: `goals`, `sessions`, `outbox`, `sync_meta`, `active_session`, `credentials`.

**Write path** (the C1 fix): a mutation writes to IndexedDB **and** enqueues an outbox op in one transaction. *That* is the commit point — the UI says "saved" then, not after the network. The sync engine drains the outbox separately and can retry forever.

**Sync engine**:
- **Pull**: one `values.batchGet` for all three tabs (replaces 3 separate calls + 2 duplicate `fetchLogs` on the stats page — C17), reduce by LWW, merge, then re-apply pending outbox ops on top so the UI never flickers backwards.
- **Push**: drain the outbox, batching multiple rows per `append`.
- **Triggers**: app start, `online` event, debounced 2s after a mutation, `visibilitychange`→visible, 60s poll while visible, manual button.
- **Backoff**: exponential + jitter on 429/5xx, honouring `Retry-After`, capped at 5 min. Sheets allows 60 writes/min/user, and batching keeps us far under.

**Deferred**: Background Sync via the service worker (syncing while the app is *closed*) needs the JWT signing duplicated in the SW. Doable — IndexedDB and `crypto.subtle` are both available there — but it's a real complexity jump for little gain, since the timer only runs while the app is open. Noted as future work.

### 2.5 Timer: derive from wall clock, never accumulate

Replace the `+1 per tick` counter (C2) with a **segment list**: `segments: [{start, end|null}]`.
- `elapsed = Σ closed segments + (now − open.start)`, recomputed each tick and on `visibilitychange`. Immune to background throttling and tab suspension.
- Pause/resume falls out for free (close a segment / open a new one) — a genuinely missing feature, not just a bug fix.
- Duration is stored in **seconds**, and adjustment is allowed in **both directions** (fixes C3, where under-counting couldn't be corrected).
- Cross-tab via `BroadcastChannel` + a single `active_session` record (fixes C11).
- Long-session guardrail replaces the silent 24h delete (C12): at 8h, prompt; hard cap 24h offering "trim to N hours" — but **never** discard without asking.
- Display switches to `H:MM:SS` past an hour (fixes C15's `122:05`).

### 2.6 UI

Tailwind v4 + shadcn/ui (Radix underneath, so the modal gets focus trap, Escape, and correct ARIA for free — fixing the whole modal a11y cluster). `sonner` toasts replace `alert()`. Dark mode via CSS variables.

**Charts**: drop `d3` entirely, keep Recharts. The heatmap gets hand-rolled as a CSS grid — ~40 lines, and it fixes the real bug (C: rows currently aren't weekdays and columns aren't calendar weeks) while colouring by **minutes** rather than session count, so a 4-hour block no longer looks like a 4-minute one.

**Routes**: `/` dashboard (today's total, active-session bar, goal cards with week/target progress, sync status, ⌘K to start any timer) · `/goal/[id]` (timer + editable session history + backfill) · `/stats` (cross-goal) · `/settings` (credentials, goal CRUD, sheet tools, appearance) · `/setup` (onboarding wizard with CSV downloads + **Test connection**, which validates tabs and headers before saving — turning a whole class of silent failures into one clear message).

`/settings` also fixes the verified dead end where there is no way back to `/credentials` once saved.

### 2.7 Next.js 16 upgrade

Checked the upgrade guide — the surface here is small. No middleware, no `next/image`, no parallel routes, no AMP, no PPR, no runtime config. Node 22.20 ✓ satisfies the 20.9+ floor.

What actually applies: Turbopack becomes default (drop `--turbopack`); `next lint` is **removed**, which forces the proper fix for our broken linting (C: `Cannot serialize key "parse"`) by migrating to the ESLint CLI with flat config; `next build` no longer lints, so lint becomes its own CI step; async `params` is now mandatory — and we're already compliant (`React.use(params)` and the `useParams()` hook). Browser floor becomes Chrome 111+/Safari 16.4+, which is fine for the PWA APIs we want.

---

## 3. Tasks

### PART A — correctness & foundations (~32h) → **your review gate**

**Phase 0: Tooling & upgrade (~5h)**
1. Upgrade to Next 16 + React 19.2 via `@next/codemod upgrade latest`; verify build (1.5h) | Deps: none | Risk: M
2. Migrate `next lint` → ESLint CLI flat config; **verify it actually runs** (1h) | Deps: 1 | Risk: L
3. Add TypeScript (incremental, `allowJs`), Prettier, `typecheck` script (1.5h) | Deps: 1 | Risk: L
4. Add Vitest + Playwright scaffolding; GitHub Actions CI (lint/typecheck/test/build) (1h) | Deps: 3 | Risk: L
5. Delete dead weight: `googleapis`, `jsonwebtoken`, `axios`→`fetch`, `Timer.jsx`, `page.module.css`, default SVGs; `npm audit fix` (0.5h) | Deps: none | Risk: L

**Phase 1: Schema & contracts (~5h)**
6. Zod schemas + row serialize/parse for goals/sessions/meta, incl. `UNFORMATTED_VALUE` handling (2h) | Deps: 3 | Risk: L
7. Generate `sheet-template/*.csv` + `SETUP.md` + optional `summary` formula (1.5h) | Deps: 6 | Risk: L
8. Unit tests: round-trip, DST/timezone, malformed rows, C8/C9/C10 regressions (1.5h) | Deps: 6 | Risk: L

**Phase 2: Local store & sync (~11h)**
9. Dexie schema + typed repositories for goals/sessions (2h) | Deps: 6 | Risk: L
10. Sheets client on `fetch`: `batchGet` pull, batched `append` push, token cache, id validation, backoff (3h) | Deps: 6 | Risk: M
11. LWW reducer + merge (tombstones, `device_id` tiebreak) (2h) | Deps: 9,10 | Risk: **H** — the subtlest logic here
12. Outbox + sync orchestrator (triggers, debounce, retry, status surface) (2.5h) | Deps: 11 | Risk: **H**
13. Unit tests: idempotent retry, concurrent-device conflicts, tombstone propagation, offline→online drain (1.5h) | Deps: 12 | Risk: M

**Phase 3: Auth & setup (~6h)**
14. Non-extractable `CryptoKey` import + IndexedDB persistence; discard PEM; JWT signing (2.5h) | Deps: 9 | Risk: M
15. `/setup` wizard: CSV download, credential entry, **Test connection** (validates tabs/headers/schema_version) (2h) | Deps: 14,10 | Risk: L
16. `/settings` credential management + reset/change-sheet path (1h) | Deps: 15 | Risk: L
17. CSP + security headers via `next.config` (0.5h) | Deps: 1 | Risk: L

**Phase 4: Timer (~5h)**
18. Segment-based timer engine: wall-clock derived, pause/resume, `visibilitychange` reconcile (2h) | Deps: 9 | Risk: M
19. Cross-tab coordination via `BroadcastChannel` + single active session (1.5h) | Deps: 18 | Risk: M
20. Guardrails: long-session prompt, sub-minute warning, bidirectional adjustment, crash recovery (1h) | Deps: 18 | Risk: L
21. Unit tests: throttled-tab simulation, DST crossing, pause/resume, cross-tab (0.5h) | Deps: 19 | Risk: L

### PART B — experience (~28h)

**Phase 5: UI rebuild (~13h)** — Tailwind v4 + shadcn init (1.5h) · design tokens + dark mode (1.5h) · app shell/nav/sync indicator (1.5h) · dashboard (3h) · goal page + editable session history + backfill (3.5h) · settings goal CRUD (2h)
**Phase 6: Stats (~4h)** — remove d3 (0.5h) · CSS-grid heatmap, correct weekday alignment, minute-scaled (2h) · trend + cross-goal charts (1.5h)
**Phase 7: PWA (~5h)** — Serwist 9.5 + SW with `NetworkOnly` for googleapis (2h) · manifest + generated icons (1h) · install prompt, offline banner, `storage.persist()` (1h) · Lighthouse PWA pass (1h)
**Phase 8: Hardening (~6h)** — Playwright E2E incl. **offline→log→online→sync** (2.5h) · a11y/axe + keyboard pass (1.5h) · error boundaries + empty/loading/error states everywhere (1h) · README + docs (1h)

**Total**: ~60h (~32h Part A, ~28h Part B)

---

## 4. Quality strategy

**Unit (Vitest)** — the logic where bugs hide: duration/segment math, DST and timezone boundaries, row serialize/parse, LWW reducer, outbox idempotency, `local_date` derivation.

**E2E (Playwright, Sheets API mocked via route interception)** — no real credentials needed in CI:
- **Offline → log a session → go online → assert it syncs** (guards C1, the headline bug)
- Retry after a lost response appends no duplicate (guards idempotency)
- Setup wizard rejects a malformed sheet with a clear message
- Background-tab timer accuracy (guards C2)

**Coverage target**: 90% on `lib/` (sync, timer, schema — the load-bearing code); no target on presentational components.

**Regression tests pinned to explicit findings**: C1, C2, C3, C6, C7, C8, C9, C10, C11, C12, C14, C15.

---

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Sync merge logic is subtly wrong → silent data corruption** (tasks 11–12) | **H** | Highest-risk item in the plan. Pure functions, property-based tests over random op orderings, append-only means originals are never destroyed and the sheet is a full audit trail |
| Append-only sheet is less human-readable | M | Optional read-only `summary` tab; "Compact sheet" button in Settings |
| Next 16 upgrade churn | M | Codemod first, isolated commit, build verified before anything else lands. Surface is small (no middleware/image/PPR) |
| Tailwind v4 + shadcn setup differs from most guides (v3-era) | M | Confirmed v4-compatible CLI (`shadcn` 4.16.0). Verify against current docs at implementation time, not from memory |
| Sheets rate limits (60 writes/min/user) | L | `batchGet` for reads, batched appends, debounced sync, backoff honouring `Retry-After` |
| IndexedDB eviction loses queued work | M | `navigator.storage.persist()`; sync aggressively so the queue is rarely non-empty; visible pending-count badge |
| Scope is large; momentum stalls | M | The Part A gate ships a fully working, data-safe app before any UI work begins |

**Assumptions**
- Service-account auth continues to work from the browser (CORS on `oauth2.googleapis.com` — this is how the app works today, so it's proven, but it isn't a documented Google use case and could change).
- You'll create a **new** spreadsheet from the CSVs and share it with the service account email.
- Single primary user. Multi-device (desktop + phone) is supported; multi-*user* is not in scope.
- ~1,800 sessions/year — comfortably inside Sheets' limits.

**Out of scope** (deliberately)
- Migrating existing history (your call: fresh start). Old sheet stays untouched as an archive.
- Background Sync while the app is closed (§2.4).
- Google OAuth user consent — needs a server, and no-server is firm.
- Multi-user accounts; the shared service account in `README.md:20`.
- Push notifications, calendar integration, timeboxing/Pomodoro presets.

---

## 6. Open question

**Phase 7 (PWA) currently sits in Part B, after the whole UI rebuild.** If you want the app installable on your phone sooner, I can pull it forward to the end of Part A — it's independent of the UI work. Worth deciding before I start.
