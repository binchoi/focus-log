# Plan: Cross-device active timer

**Created**: 2026-08-04 | **Effort**: ~26–32h | **Complexity**: Complex
**Branch**: `binchoi/explore-cross-device-timer` | Based on `EPCC_EXPLORE_cross_device_timer.md`
**Decisions locked**: dedicated `active` tab · web-full + shared vectors + Wear `:core` (Wear UI follow-up) · plain LWW (last write wins)

## 1. Objective
**Goal**: Publish the running timer to the shared Google Sheet so a session started on
one device (PWA desktop/mobile, or the Wear OS watch) can be seen, paused, and ended
from another — with no server and no sheet-side/Apps Script logic.
**Why**: Today the active timer is device-local (`activeSession` in IndexedDB, never
synced), so a timer left running on the MacBook can't be stopped from the phone.
**Success**:
1. Start on device A → device B (app open) shows it "running since <time>" within ≤1 poll (~60s), with correct live elapsed (incl. pauses).
2. Stopping from any device produces **exactly one** logged session — two devices ending it never double-count.
3. TS and Kotlin `:core` produce byte-identical LWW/elapsed/duration/active-mapping results, proven by a shared conformance-vector suite both test suites run.

## 2. Approach
**Backbone (from exploration)**: mint the session `log_id` at **START**, publish it in a
shared **`active`** record carrying `segments` (so pauses travel), and **finalize under
that same id**. Two "ends" become two rows with the same `log_id` that the existing
append-only `reduceLatest` LWW collapses to one (`sync/merge.ts` / `sync/Merge.kt`,
compare `updated_at` as instant, tie-break `device_id`). No new reconciliation engine.

**New `active` tab** (append-only, LWW singleton per `log_id`), columns
`A:G`: `log_id, goal_id, segments, note, updated_at, deleted, device_id` (as implemented
in Phase 0). `deleted=TRUE` is the tombstone that tells devices the timer ended. Phase/
running-vs-paused and `started_at` are *derived from `segments`* (no separate `status` or
`started_at` column), and `segments` are packed into one cell as `startMs,endMs;startMs,`
rather than JSON (dependency-free parity with the Kotlin core). It carries `segments`
because the finalized `Session` row (start/end/duration) cannot represent a *currently
paused* timer — that's the reason for a dedicated record rather than reusing an "open"
`sessions` row.

**Lifecycle**: START → write `active{running}` + local mirror (shared `log_id`). PAUSE/
RESUME → append new version (debounced, like all mutations). STOP (any device) → append
finalized `Session` to `sessions` **with the reserved `log_id`** + append `active{closed}`
+ clear local timer. On PULL, a device seeing `active{closed}` or a `sessions` row with
that `log_id` **reconciles instead of re-finalizing**.

**Reuse (brownfield)**: `timer/engine.ts` + `TimerEngine.kt` pure functions verbatim;
the outbox/lease/LWW machinery (`sync/engine.ts`, `store/repo.ts` `commit()`);
`BroadcastChannel` for same-device tabs; `restore()` long/too_long guardrails for stale
timers.

**Trade-offs**: dedicated `active` tab | needs a one-time sheet migration + `schema_version`
2, but keeps the `sessions` schema/totals untouched and inherits LWW | vs. relaxing
`sessions` (loses pause fidelity, larger blast radius). Plain LWW on stop | zero new
logic, ends differ by seconds in practice | vs. first-close-wins (deferred).

## 3. Tasks

**Phase 0 — Wire contract & schema (foundation)** (~7h)
1. Define `active` tab: columns + zod schema (TS) and data class + codec (Kotlin); add `RANGES.active`; bump `SCHEMA_VERSION`→2 with **backward-compatible read** of v1 sheets (2.5h) | Deps: none | Risk: M
2. Author shared **conformance vectors** (`/conformance/*.json`): LWW compare/reduce (instant + device_id + tombstones), segments→elapsed/duration (pauses, backward-clock, floor), active→finalized-session mapping, `active` row codec (2.5h) | Deps: 1 | Risk: M
3. Wire both suites to the vectors: Vitest loader + `:core` JUnit loader reading the same JSON (2h) | Deps: 2 | Risk: M (cross-language file loading)

**Phase 1 — Protocol in the pure cores (TS + Kotlin)** (~8h)
4. Thread a **provided `log_id`** through `start()`/`logSession()` so finalize reuses the active id (both cores) (2h) | Deps: 1 | Risk: M
5. Active-record lifecycle (pure, testable): start→row, pause/resume→version, stop→finalized session + closed active, reconcile-on-pull (adopt remote running timer; ignore re-finalize of an id already logged) (3.5h) | Deps: 4 | Risk: **H** (subtlest logic)
6. Concurrency rules + edge tests: two-ends (same-id LWW collapse), two-starts (**earliest `started_at` wins**, others auto-closed), stale/abandoned (restore warnings), clock-skew documented (2.5h) | Deps: 5 | Risk: **H**

**Phase 2 — Sync engine (TS, then Kotlin `:core`)** (~5h)
7. Extend outbox + push/pull for entity `"active"`; add `active` range to the `readAll` `batchGet`; drain order goals→sessions→active (3h) | Deps: 5 | Risk: M
8. Reconcile pulled active record into the local timer store (`TimerStore` / Kotlin store), converging with `BroadcastChannel` for same-device tabs (2h) | Deps: 7 | Risk: M

**Phase 3 — Web UX & migration** (~5h)
9. "Running on <device> since <time>" indicator; pause/stop-from-any-device wiring; reconcile UI when a remote close arrives (2.5h) | Deps: 8 | Risk: M
10. Migration: `active.csv` template + `sheet-template/SETUP.md` step; **graceful degrade** when the `active` tab is absent (feature off, everything else works — no errors); migrate prompt (2.5h) | Deps: 1,7 | Risk: M

**Phase 4 — Verification** (~4h)
11. Playwright e2e: two browser contexts = two devices — start on A / stop on B → one session; concurrent stop → converge, no double count (2.5h) | Deps: 9 | Risk: M
12. Wear `:core` JUnit: shared-vector parity + active-lifecycle tests (headless `./gradlew :core:test`). `:wear` Android UI wiring documented as follow-up (1.5h) | Deps: 5,7 | Risk: L

**Total**: ~26–32h. **Critical path**: 1→2/3 (contract) → 4→5→6 (protocol) → 7→8 (sync) → 9→11.

## 4. Quality Strategy
**Shared vectors** (the keystone): identical JSON golden cases assert LWW/elapsed/
duration/active-mapping in **both** Vitest and `:core` JUnit — divergence fails CI on the
platform that drifts.
**Unit**: active-record lifecycle + concurrency rules on both cores (target: parity with
existing `merge`/`engine` coverage).
**Integration/e2e**: two-context Playwright for cross-device start/stop/converge (mirrors
`e2e/sync.spec.ts`).
**Validation = success criteria §1**: cross-device visibility ≤60s, single-session-on-stop,
cross-core parity.

## 5. Risks
| Risk | Impact | Mitigation |
|------|--------|-----------|
| LWW/elapsed diverges across TS & Kotlin cores | H | Shared conformance vectors run by both suites (Tasks 2–3) — the primary safeguard |
| Migration bricks existing v1 sheets (no `active` tab) | H | Backward-compatible read + **graceful degrade** to local-only when tab absent (Tasks 1,10); never hard-error |
| Double-count on concurrent stop | H | Start-minted shared `log_id` → same-id LWW collapse; reconcile-on-pull skips re-finalize (Tasks 4–5) |
| Concurrent starts on two devices | M | "earliest `started_at` wins, others auto-closed" rule + edge test (Task 6) |
| Clock skew makes elapsed look off across devices | M | Derive elapsed locally; show "started on <device>"; document (no server clock exists) |
| Append-log growth from pause/resume churn | L | Debounced pushes + repeated-edit collapse already exist; active rows are few; compaction path exists |

**Assumptions**: both devices have the app **open** (no background sync — deferred);
the wearable's `:wear` UI is built in Android Studio (only `:core` is exercised here);
Sheets write quota (60/min) is untouched (a handful of transition writes per session).
**Out of scope**: background-sync-while-closed; Wear `:wear` Android UI implementation;
full Kotlin-Multiplatform unification; first-close-wins tiebreak (revisit later).
