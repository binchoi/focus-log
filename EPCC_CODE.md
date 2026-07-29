# Implementation: Part A — correctness & foundations

**Branch**: `feat/modernize-pwa` | **Date**: 2026-07-29 | **Status**: Complete, awaiting your review

## 1. Changes

Four commits, one per phase:

| Commit | Phase | What |
|---|---|---|
| `47bdf60` | 0 | Next 16 upgrade, working lint, TypeScript, test tooling, CI |
| `a5d87df` | 1 | Sheet schema, row codecs, CSV template |
| `f96ac35` | 2 | Local-first store, append-only sync, offline outbox |
| `88a44bd` | 3–4 | Hardened auth, setup/settings, drift-free timer, app rewired |

**New (`src/lib/`)** — the load-bearing code, ~98% covered:
- `time.ts` — UTC + local-date + IANA-zone handling
- `sheets/{columns,cells,schema,client}.ts` — one column definition drives the CSV, A1 ranges, serialiser and parser; `fetch`-based client
- `sync/{merge,engine,triggers}.ts` — LWW reduce, outbox orchestrator, sync scheduling
- `store/{db,repo,ids}.ts` — Dexie schema, goal/session CRUD, client-minted ids
- `auth/{credentials,validate}.ts` — non-extractable key, token cache, connection validator
- `timer/{engine,store,useTimer}.ts` — segment-based timer, cross-tab coordination
- `stats/heatmap.ts` — calendar-correct heatmap layout

**Rewritten** — `src/app/{page,layout,providers,sync-badge}`, `goal/[goalId]/page`, `goal/[goalId]/stats/page`, plus new `setup/` and `settings/`.

**Deleted** — `utils/googleSheetsApi.js`, the d3 `ContributionGrid`, the Recharts `Last10DaysChart`, `Navbar.jsx`, the old `credentials/` page; deps `axios`, `d3`, `googleapis`, `jsonwebtoken`.

**For you** — `sheet-template/{goals,sessions,meta}.csv` + `SETUP.md`.

## 2. Quality

| Gate | Result |
|---|---|
| Lint | **Clean** — first time in this repo's history |
| Typecheck | Clean (strict + `noUncheckedIndexedAccess`) |
| Tests | **240 passing**, 14 files |
| Coverage (`src/lib`) | 94.6% stmts · 91.0% funcs · 95.7% lines · 87.4% branches |
| Build | Clean |
| `npm audit` | 22 vulns (2 critical, 10 high) → 12, all transitive build-chain |
| Verified live | All 5 routes 200; CSP header present with the `connect-src` restriction |

Every finding below has a **pinned regression test** naming its C-number, so a future change that reintroduces it fails CI rather than silently regressing.

| # | Finding | Fix |
|---|---|---|
| C1 | Session lost on failed write | Mutation + outbox op commit in one transaction; that is the commit point, not the HTTP response |
| C2 | Timer under-counts in background tabs | Elapsed derived from timestamps; tested with a tab that ticks twice in an hour |
| C3 | Under-count couldn't be corrected | Adjustment allowed in both directions |
| C4 | Private key stealable from localStorage | Non-extractable `CryptoKey`; `exportKey` throws |
| C5 | Interval leaked on unmount | All timers/listeners torn down; asserted in tests |
| C6 | Up to 59s lost per session | Whole seconds kept |
| C7 | Sub-minute sessions wrote 0-minute rows | Real duration stored; warns before logging |
| C8 | `parseInt("1,234")` → 1 collapsed totals | `UNFORMATTED_VALUE` + separator-stripping coercion |
| C9 | `NaN === NaN` silently blanked charts | Coercion returns `undefined`, never `NaN` |
| C10 | Timezone change shifted history | UTC instant + `local_date` + IANA `tz` |
| C11 | Cross-tab desync | `BroadcastChannel` over a single active-session row |
| C12 | Overnight sessions silently deleted | Warn and offer a trim; never discard unasked |
| C13 | Duration depended on a sheet formula | App computes it |
| C14 | New goals invisible until logged | Goals no longer carry a formula-derived total |
| C15 | 2h05m rendered as "122:05" | Rolls into hours |
| C16 | Deep-link showed "Unknown Goal" | Titles read from the local store |
| C17 | 3 token mints + duplicate sheet reads per page | Token cache + one `batchGet` |
| C18 | Stopping one timer wiped another's | Clearing scoped to the owning goal |
| C19 | Adjustment input rejected keystrokes | Free-text input, clamped on submit |
| C20 | Dead code | Removed |

Plus: no route back to credentials (→ `/settings`), no goal CRUD / log editing / backfill (→ all in-app), heatmap rows weren't weekdays, cross-origin font `@import` overriding Geist, missing focus rings, no dark mode, `100vh` on mobile.

## 3. Decisions

**Sheet as an append-only log.** Chosen over `values.update` because row indices shift when you edit the sheet by hand, which is unfixable offline. Buys idempotent retries (a lost response re-appends an identical row that the reducer collapses), deterministic multi-device merge, and immunity to manual edits. Cost: multiple rows per edited session, mitigated by an optional read-only `summary` tab and a planned "Compact sheet".

**Outbox leased, not deleted optimistically.** "Delete then send" loses work if the tab closes mid-flight; "send then delete" can double-send. Leasing plus client-minted ids makes the worst case a harmless duplicate row.

**Offline is a result, not an exception.** `sync()` returns `deferred: true` rather than throwing. Caught by a test — my first version threw, which would have made the primary use case an error path.

**`updated_at` compared as parsed instants, not strings.** As text, `"…00:00Z" > "…00:00.000Z"` (`'Z'` > `'.'`), so a naive compare would make the conflict winner depend on which client wrote the row.

**Dexie live queries over effect+setState.** Adopted to fix React 19.2 hook lint errors, but the real win is that a background sync updates the UI with no manual refetch wiring.

**ESLint pinned to 9.x.** `eslint-config-next@16.2.12` ships a parser whose `ScopeManager` lacks `addGlobals`, which ESLint 10 calls — every run dies. Rationale recorded in `eslint.config.mjs`.

## 4. Handoff

**Your next step**: create the spreadsheet from `sheet-template/` (see its `SETUP.md`), then run `npm run dev` and visit `/setup`. **Test connection** validates everything before saving.

**Not done in Part A** (all Part B, as planned): Tailwind v4 + shadcn rebuild, Radix dialogs with real focus traps, ⌘K palette, cross-goal stats, PWA (manifest/service worker — still 404), Playwright E2E.

**Known gaps**:
- React hook glue (`use*.ts`) is excluded from the coverage target, documented in `vitest.config.mts`; the engines beneath it are ~98% covered. Phase 8's E2E closes this.
- Service-account auth from the browser depends on `oauth2.googleapis.com` CORS. This is how the app already worked, so it's proven — but it isn't a documented Google use case and could change.
- **The whole stack is untested against a real spreadsheet.** I have no credentials, so sync is verified against a fake sheet that mimics append-only semantics. First real run is the genuine test.
- No visual review was possible (Chrome extension declined), so the interim styling is unreviewed. Part B replaces it anyway.
