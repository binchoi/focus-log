# Exploration: focus-log — modernization baseline

**Date**: 2026-07-29 | **Scope**: Deep | **Status**: ✅ Complete
**Goal of exploration**: establish a full baseline before a desktop-first UX rebuild, guardrail/edge-case hardening, and PWA offline+sync work.

---

## 1. Foundation (what exists)

**Tech stack**
| Item | Installed | Current | Note |
|---|---|---|---|
| Next.js | 15.1.4 (App Router, Turbopack dev) | 16.2.12 | one major behind |
| React | 19.0.0 | 19.2.8 | |
| Language | JavaScript only | — | no `tsconfig.json`, **no typechecking** |
| Styling | hand-written global CSS (`globals.css`, 497 lines) | — | no Tailwind, no component lib |
| Charts | `d3` 7 (imperative SVG) **and** `recharts` 2 | — | two chart libs for two charts |
| HTTP | `axios` | — | |
| Dates | `date-fns` 4 | — | |

**Architecture**: Next.js App Router SPA that is **100% client-side**. Every page is `"use client"`. There are no API routes, no server actions, no server components with data access. Google Sheets is the entire backend; the browser talks to `sheets.googleapis.com` directly.

**Entry points & structure**
```
focus-log/
├── src/app/
│   ├── layout.js              root layout, loads Geist via next/font
│   ├── page.js                / — goal grid (62 ln)
│   ├── credentials/page.jsx   /credentials — service-account entry (103 ln)
│   ├── goal/[goalId]/page.jsx timer + log modal (217 ln)  ← the core screen
│   └── goal/[goalId]/stats/page.jsx  charts shell (25 ln)
├── components/  Navbar.jsx, ContributionGrid.js (d3), Last10DaysChart.js (recharts)
└── utils/googleSheetsApi.js   the whole data layer (240 ln)
```

**Data model** (inferred from API calls — *see Gaps, this is unverified*)

Three tabs in one user-owned spreadsheet:
- `goals!A:B` → `g_id`, `title`
- `summary!A:B` → `g_id`, `total_duration` (minutes) — **spreadsheet-computed**
- `logs!A:D` → `start`, `end`, `g_id`, `duration` — app writes **A:C only**; column D is **spreadsheet-computed**

**No CLAUDE.md** anywhere in the repo (only the user-global one). No project conventions are written down.

**No test infrastructure at all**: no test files, no test script, no CI, no `.github/`.

---

## 2. How it currently works (traced end-to-end)

**Auth flow** — `utils/googleSheetsApi.js:123-198`
1. User pastes/uploads a Google **service account JSON** at `/credentials`.
2. `{privateKey, clientEmail, spreadsheetId}` → `localStorage` (`credentials/page.jsx:43`).
3. On every API call, the browser builds a JWT by hand, signs it with `crypto.subtle` (`RSASSA-PKCS1-v1_5`), and exchanges it at `oauth2.googleapis.com/token` for a 1h access token.

**Logging flow** — `goal/[goalId]/page.jsx`
`Start` → write `startTime` to `localStorage` → `setInterval(+1s)` → `Stop` → modal → `Log Session` → delete localStorage state → `appendLog()` POST → `alert()`.

**Read flow**: `/` calls `fetchSummary()` (2 GETs) and caches `goalsMap` to `localStorage`. Goal/stats pages read titles from that cache.

**Verified live**: `npm run build` succeeds. All routes return 200. Dev server runs clean.

---

## 3. Findings — correctness & data integrity

Ordered by severity. All verified against source; empirically confirmed items are marked ✓.

### 🔴 Critical

**C1. Session data loss on network failure** — `goal/[goalId]/page.jsx:100-108`
localStorage timer state is deleted **before** the network write is attempted, and `appendLog` is fire-and-forget with `.catch(console.error)`. If the request fails (offline, expired key, throttled), **the session is gone permanently and the user is never told** — they see no alert, only a console error. This is the single most damaging bug and is the direct motivation for an offline queue.

**C2. The timer under-counts whenever the tab isn't focused** — `page.jsx:72-79`
`resumeTimer` does `setFocusTime(prev => prev + 1)` on a 1s interval. It never consults wall-clock time. Browsers throttle background timers (≈1/min in hidden tabs; iOS suspends them entirely). A 60-minute session run in a background tab logs a fraction of the real time. For a focus timer this is a correctness failure of the core feature. The fix is to derive elapsed time from `startTime` on each tick and on `visibilitychange`.

**C3. Under-counting cannot be corrected** — `page.jsx:136-140`
`handleAdjustmentChange` rejects any value `> Math.floor(focusTime/60)`. So adjustment is **downward-only**. C2 loses time and C3 forbids adding it back — the two bugs compound into unrecoverable data loss.

**C4. Service-account private key in `localStorage`** — `credentials/page.jsx:43`
An RSA private key with `auth/spreadsheets` scope, stored in plaintext, readable by any script on the origin, **with no expiry and no revocation path in the app**. Any XSS or malicious dependency exfiltrates permanent write access to the sheet. Per the root `README.md:20`, a **shared** service account is used across users — so one leak affects everyone. This is the most serious security issue.

### 🟠 High

**C5. Interval is never cleaned up** — `page.jsx:26-52, 72-79`
The mount effect calls `resumeTimer()` (which creates an interval) and returns no cleanup function. Navigating away from the goal page leaks the interval for the lifetime of the page. The handle is also stored in React state rather than a ref, so a re-render path can orphan it.
*(Checked: `reactStrictMode` default is `null` in Next 15, so the dev double-invoke double-count does not currently occur — but enabling strict mode would surface it.)*

**C6. Seconds are silently discarded on every log** ✓ — `page.jsx:90`
`Math.floor(focusTime/60)`. A 25m59s session logs as 25m — up to 59s lost per session, systematically biased downward.

**C7. Sub-minute sessions write a zero-duration row** ✓ — `page.jsx:104`
A 50s session logs `0` minutes, so `start === end`. Garbage rows accumulate in the sheet with no validation.

**C8. `parseInt` on locale-formatted numbers corrupts totals** ✓ — `page.js:40`
The Sheets API `valueRenderOption` defaults to `FORMATTED_VALUE`, so a total of 1234 can arrive as `"1,234"`. `parseInt("1,234")` → **1**. Verified. Totals silently collapse once a goal passes 1,000 minutes. Fix: request `UNFORMATTED_VALUE`.

**C9. Non-numeric `g_id` silently zeroes all charts** ✓ — `ContributionGrid.js:18`, `Last10DaysChart.js:24`
`log.g_id === parseInt(goalId)`; `parseInt("health")` → `NaN`, and `NaN === NaN` is `false`. Any non-integer goal id makes every chart render empty with no error. Types are inconsistent across the codebase: strings in `fetchSummary`/`goalsMap`, integers in `fetchLogs`.

**C10. Hand-written datetime strings are timezone- and locale-fragile** ✓ — `googleSheetsApi.js:68-87, 201-203`
Times are written as local-time `MM/DD/YYYY HH:mm:ss` with no offset, then read back with `new Date("01/15/2025 14:30:00")` — a **non-standard format** whose parsing is implementation-defined (works in V8; `new Date("15/01/2025 …")` is `Invalid Date`). Because no offset is stored, travelling across timezones or crossing a DST boundary shifts historical data. Fix: store ISO-8601 with offset, or UTC + a separate local-date column.

**C11. Cross-tab and cross-device timer state desync** — `page.jsx:48-51`, `page.js:27-30`
`active_timer` is read **once on mount** with no `storage` event listener and no `BroadcastChannel`. Two tabs can each start a timer on different goals. The home page's active-goal highlight never updates. Nothing reconciles a timer started on the phone with one on the desktop.

**C12. Overnight sessions are destroyed silently** — `page.jsx:23, 38-44`
A 24h TTL discards stored timer state with `localStorage.removeItem` and no warning or recovery prompt.

**C13. Writes depend on invisible spreadsheet formulas** — `googleSheetsApi.js:101-105`
The app appends `A:C` only; `duration` (col D) and the whole `summary` tab are computed **in the sheet**. If those formulas aren't `ARRAYFORMULA`-style auto-extending, appended rows get no duration → totals and charts silently read 0. This coupling is precisely why the app "requires visiting the sheet."

### 🟡 Medium

**C14. New goals are invisible until they have a log** ✓ — `googleSheetsApi.js:46`
`.filter(row => row[0] && row[1])`. The Sheets API omits trailing empty cells, so a goal whose `summary` total is blank has `row[1] === undefined` → filtered out. A freshly created goal doesn't appear on the home page at all.

**C15. Timer display breaks past one hour** ✓ — `page.jsx:154-155`
Renders `MM:SS` from `Math.floor(focusTime/60)`, so a 2h05m session shows **`122:05`**. The modal (`:181`) correctly shows `h`/`m` — inconsistent within one screen.

**C16. Deep-linking a goal shows no title** — `page.jsx:27-31`
`getTitleByGid` reads only the `goalsMap` localStorage cache populated by a prior visit to `/`. Open `/goal/3` directly (bookmark, refresh, future PWA shortcut) and the title is `"Unknown Goal"` with no fetch fallback. Confirmed via SSR HTML: `<h1 class="goal-title"></h1>`.

**C17. Redundant token minting and duplicate sheet reads** — `googleSheetsApi.js`
Access tokens are never cached; every one of `fetchSummary`/`appendLog`/`fetchLogs` mints a fresh JWT (RSA sign + token exchange). Worse, `ContributionGrid` and `Last10DaysChart` **each call `fetchLogs()` independently** on the same stats page → the entire logs sheet is downloaded twice and 2 tokens minted per page view.

**C18. Discarding a session clears another goal's active marker** — `page.jsx:114-127`
`handleDiscardSession`/`handleLogSession` unconditionally `removeItem(ACTIVE_TIMER_KEY)`, and `resetState` sets `isAnotherTimerActive = false`, discarding knowledge of a genuinely-running timer on a different goal.

**C19. Adjustment input rejects keystrokes instead of validating** — `page.jsx:130-144`
On an out-of-range value the handler `return`s **without updating state**, so the controlled input desyncs from what's typed. With a 25m max, typing `3` is rejected outright — you can't reach `30` even to then correct it.

**C20. Dead code path** — `page.jsx:98` — `const now = new Date();` is computed and never used.

---

## 4. Findings — UX, accessibility, design

**No way to reach `/credentials` from the UI.** Verified: the only reference is an automatic `router.push` when credentials are *absent* (`page.js:17`). Once saved, changing spreadsheet or fixing a bad key requires manually clearing `localStorage`.

**Missing capabilities** (all currently require opening the spreadsheet by hand — this is the core complaint):
- create / rename / reorder / archive / delete goals
- view, edit, or delete past log entries
- manually add a past session (backfill)
- set targets or goal-level intentions
- any cross-goal view: today's total, week total, goal comparison
- no pause/resume — `Stop` is terminal; the modal has no "keep going" exit

**Accessibility gaps** — modal at `page.jsx:177-214`:
- no `role="dialog"` / `aria-modal`, no focus trap, no Escape-to-close, background not inert
- `alert()` used for success and as the only error surface (`:107`) — blocking, unstyleable, hostile on mobile
- error tooltip is a plain `div`, not `role="alert"`/`aria-live`, and not linked to the input via `aria-describedby`
- no keyboard shortcuts (space to start/stop)
- `type="password"` on **Client Email** (`credentials/page.jsx:80`) — obfuscates a non-secret and blocks autofill
- no loading, empty, or error states on `/`: on fetch failure the grid stays permanently blank (verified: SSR emits `<div class="goals-grid"></div>`)

**Styling issues** in `globals.css`:
- line 1 imports Google Fonts for `Helvetica`, then `body` sets `font-family: Helvetica` — which **overrides the Geist fonts** that `layout.js` loads via `next/font`. Geist is downloaded on every page and never used. *(The import does return 200 — Google serves it — so it's redundant rather than broken.)*
- `.btn` is declared twice with conflicting padding (`:175` and `:303`)
- bare element selectors (`header`, `a`) leak globally
- `min-height: 100vh` throughout — the known mobile-Safari address-bar bug; `100dvh` is the modern fix
- no dark mode: zero `prefers-color-scheme` rules
- the stats page dodges the fixed navbar with an inline `marginTop: "80px"` hack (`stats/page.jsx:15`)

**ContributionGrid is mislabelled as a GitHub-style grid** — `ContributionGrid.js:103-104`
Cells are positioned by array index (`x = ⌊i/7⌋`, `y = i % 7`), so **row 0 is whatever weekday the quarter happens to start on** — verified: Tue for Q3 2025, Wed for Q4 2025, Thu for Q1 2026. Columns are therefore not calendar weeks and rows are not weekdays. There are no month or weekday labels, so cells are unidentifiable without hovering. It also counts *sessions per day*, not minutes, so a 4-hour block and a 4-minute block look identical. *(Checked and ruled out: the fixed 500×300 viewBox does **not** clip — worst case is 492px wide.)*

Also: the d3 tooltip is appended to `document.body` and re-created on every `logs` change; only the effect return removes it.

---

## 5. Findings — infrastructure & PWA readiness

**PWA: nothing exists.** Verified live — `/manifest.json` → 404, `/sw.js` → 404. No manifest, no service worker, no icons, no offline handling, no install prompt, no cache strategy. `public/` contains only the five unused default Next.js SVGs.

**Offline behaviour today**: the app is a hard-fail. Every read and write hits the network directly; going offline means a blank goal grid and silently lost sessions (C1). There is no queue, no optimistic local store, no reconciliation.

**Dead weight**:
- `googleapis` (^144) — **never imported**; only URL substrings matched. A large server-only package in a client bundle's dep tree.
- `jsonwebtoken` (^9.0.2) — **never imported** at all (signing is hand-rolled).
- `components/Timer.jsx` — **0 bytes**.
- `src/app/page.module.css` — 168 lines, never imported.
- Two chart libraries for two charts; the stats route is **246 kB First Load JS** (vs 131 kB for `/`).

**`npm run lint` is broken**: fails with `Cannot serialize key "parse" in parser: Function values are not supported.` Linting has therefore not been running — during build either. No formatter (no Prettier/Biome config).

**`npm audit`: 22 vulnerabilities (2 critical, 10 high)**, dominated by ~30 advisories against the pinned `axios` 1.7.9 (SSRF, prototype pollution, credential leakage). Most are `npm audit fix`-able. Note that axios is only used for four simple calls — `fetch` would remove this surface entirely.

**No input validation on `spreadsheetId`** — a user-supplied string is interpolated straight into the Sheets API URL path (`googleSheetsApi.js:10, 20, 101, 213`) with no format check or encoding.

---

## 6. Library landscape (verified against the npm registry, 2026-07-29)

Relevant because the modernization asks about shadcn and PWA specifically:

| Package | Latest | Last publish | Verdict |
|---|---|---|---|
| `serwist` / `@serwist/next` | 9.5.12 | **2026-07-22** | actively maintained; the successor for Next.js service workers |
| `next-pwa` | 5.6.0 | **2022-08-23** | **abandoned ~4 years** — avoid |
| `shadcn` (CLI) | 4.16.0 | 2026-07-27 | active |
| `tailwindcss` | 4.3.3 | 2026-07-28 | v4 — different setup from the v3 most guides assume |
| `@tanstack/react-query` | 5.101.4 | 2026-07-21 | active; has offline/pause-on-network-loss semantics that map well to C1 |
| `dexie` | 4.4.4 | 2026-06-16 | IndexedDB wrapper for a local-first log store |
| `zod` | 4.4.3 | 2026-05-04 | active — would address the untyped sheet-row parsing (C8/C9/C10) |
| `vitest` / `@playwright/test` | 4.1.10 / 1.62.0 | 2026-07-24 / 2026-07-28 | both active; no test infra exists today |

---

## 7. The central architectural tension (for PLAN)

The offline-PWA goal and the current design are in direct conflict, and this is the decision that shapes everything else:

**Derived values live in the spreadsheet, not the app.** `duration` (logs col D) and the entire `summary` tab are sheet formulas (C13). An offline-capable app must compute its own durations and totals locally — which means the app has to own that logic, and the sheet becomes a sync target rather than a source of truth. That single change is also what unlocks nearly every missing feature in §4 (goal CRUD, log editing, backfill, cross-goal stats).

**The credential model blocks multi-device use.** A service-account private key in `localStorage` (C4) can't be safely synced to a phone, and the shared-account approach in `README.md:20` doesn't scale. Google **OAuth user consent** (with a token exchange behind a server route) is the standard alternative and would remove the private key from the browser entirely — but it requires a server component, which changes the "no-server" premise. This is a genuine trade-off, not an oversight, and needs your decision.

---

## 8. Gaps requiring your input

1. **The spreadsheet template is not in the repo.** I inferred the schema from API calls; I have not seen actual column types, the `duration`/`summary` formulas, or whether `g_id` values are integers. This is the highest-value unknown — everything in §3 about data parsing depends on it. Sharing the template (or a screenshot / a few sanitized rows) would let me confirm C8, C9, C10, C13, C14 rather than infer them.
2. **"No-server" — how firm?** Keeping it means living with C4. Adding one lightweight route (Vercel function) enables real OAuth and a much safer credential story.
3. **Sheets as source of truth, or as a sync mirror?** The latter is required for genuine offline; it also means the app may overwrite sheet-side manual edits.
4. **Single-user or the "few friends"** in `README.md:18`? This decides whether goal management needs to be per-user.
5. **No visual review was possible** — the Chrome extension was declined, so my UI critique is from CSS and markup, not rendered screenshots. I also have no credentials, so I could not exercise the live logging path end-to-end (C1/C2 are read from source, not reproduced in a browser).

---

## 9. Handoff

**For PLAN**
- Settle §7 and §8 first — they gate the rest.
- Suggested sequencing: (a) stop the bleeding (C1, C2, C3, C6, C7 — data integrity), (b) own the data model locally (enables C8–C14 + the missing features), (c) rebuild the UI, (d) layer on the service worker + sync.
- C1/C2/C3 are worth fixing regardless of every architectural decision.

**For CODE**
- `npm run dev` (Turbopack), `npm run build` — both work.
- **Fix `npm run lint` before relying on it.** Consider adding TypeScript, Prettier/Biome, and Vitest — none exist.
- Drop `googleapis`, `jsonwebtoken`, `components/Timer.jsx`, `src/app/page.module.css`; consider dropping `axios` (removes ~30 advisories) and consolidating on one chart library.

**For COMMIT**
- No existing quality gates to satisfy — coverage target, lint, and typecheck all need to be established, not met.
- `npm audit fix` for the 22 advisories.
- Baseline to protect: `npm run build` passes; all 5 routes return 200.
