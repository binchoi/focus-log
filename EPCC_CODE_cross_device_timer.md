# Implementation: Cross-device active timer — Phase 0 (foundation)

**Date**: 2026-08-04 | **Branch**: `binchoi/explore-cross-device-timer` | **Status**: Phase 0 complete
**Plan**: `EPCC_PLAN_cross_device_timer.md` (Phase 0: `active` schema in both cores, `SCHEMA_VERSION`→2 backward-compatible, shared conformance vectors wired into both suites)

## 1. Changes

**New shared `active` tab schema (both cores)** — the versioned running-timer record,
keyed by `log_id` (minted at start, reused at finalise), carrying `segments` so pauses
travel; `deleted=TRUE` is the tombstone.
- TS: `src/lib/sheets/columns.ts` (`ACTIVE_COLUMNS`, `TAB_NAMES.active`, `RANGES.active`),
  `src/lib/sheets/schema.ts` (`ActiveTimer`, `parseActiveRows`, `activeToRow`,
  `encodeSegments`/`decodeSegments`).
- Kotlin: `core/.../sheets/Columns.kt`, `core/.../sheets/RowCodec.kt`,
  `core/.../model/Records.kt` (`ActiveTimer`).

**`segments` cell encoding** — `startMs,endMs;startMs,` (open segment = blank end).
Deliberately not JSON so it parses identically in TS and dependency-free Kotlin.

**`SCHEMA_VERSION` 1 → 2, backward-compatible** — a v2 client still reads/writes a v1
sheet, leaving the timer feature off until the sheet is migrated:
- `isSchemaCompatible` now allows `remoteVersion <= SCHEMA_VERSION` (TS `sync/engine.ts`,
  Kotlin `sync/SyncEngine.kt`).
- `auth/validate.ts`: an older sheet is a **warning**, not an error (it still connects).

**Shared conformance vectors** `/conformance/*.json` (`elapsed`, `lww`, `segments-codec`),
loaded by **both** suites so the cores can't drift on LWW ordering, elapsed/duration, or
the segments codec:
- TS: `src/lib/conformance.test.ts`. Kotlin: `core/.../ConformanceTest.kt` (+ tiny
  dependency-free `MiniJson.kt`; vector path passed via a Gradle `systemProperty`).

**Template + docs** — `scripts/generate-sheet-template.ts` now emits `active.csv`, bumps
`meta.csv` to v2, and `sheet-template/SETUP.md` documents the tab + a "Migrating an
existing sheet (v1 → v2)" section.

## 2. Quality
- **TS**: 311 unit tests pass (`npm run test`), `tsc --noEmit` clean, `eslint .` clean.
- **Kotlin `:core`**: 99 tests pass headless (`./gradlew :core:test --offline`), incl. the
  17 conformance cases — the **same** 17 the TS suite runs.
- The `active` codec is covered both ways (round-trip, tombstone, malformed rows) and the
  version bump's backward-compat is covered in `validate.test.ts` / `engine.test.ts`.

## 3. Decisions
- **`segments` as a delimited cell, not JSON**: keeps the Kotlin `:core` dependency-free
  and its tests fully offline; the shared vectors guarantee both encoders agree.
- **Backward-compat over a hard version gate**: existing sheets must keep working with
  zero action; the feature stays inert until migration. So older = warning, not error.
- **Vectors as the interop contract**: cheaper and lower-risk than Kotlin Multiplatform;
  drift fails CI on whichever core diverges.

## 4. Handoff
**Next (Phase 1)**: thread a start-minted `log_id` through `start()`/`logSession()` and
add the active-record lifecycle (start → pause/resume → stop = finalized session + closed
active), then Phase 2 wires it into pull/push. Nothing in Phase 0 changes runtime behavior
yet — the `active` tab is defined but not yet read or written by the sync engine.

**Manual operations you must do** — see the message accompanying this doc and
`sheet-template/SETUP.md` → "Migrating an existing sheet (v1 → v2)". Summary: **nothing is
required right now** (Phase 0 is backward-compatible and inert); when the feature ships you
add an `active` tab and set `schema_version=2` on each of your two users' sheets.

---

## Phase 1 — pure-core lifecycle (complete)

**New pure mapping between a running timer and the sheet, in both cores** — the backbone
that makes "mint the id at start, finalise under it" work:
- `src/lib/timer/lifecycle.ts` + `core/.../timer/Lifecycle.kt`: `runningActive` /
  `closedActive` (publish/tombstone the shared `active` row), `finalizedSession` (the
  finished `Session` under the **reserved `log_id`**, focused-duration only), and
  `timerFromActive` (rebuild a controllable timer from a pulled row — elapsed always
  re-derived, never stored).
- `logSession` gains an additive `logId` option (TS `repo.ts`, Kotlin `Repo.kt`) so
  finalize reuses the start-minted id instead of generating a fresh one.

**New shared vector** `/conformance/active-mapping.json` (2 cases, incl. a +8 zone crossing
the date line) — both suites now run **19** identical conformance cases, so the
active→session mapping and ISO/duration output are provably byte-identical across cores.

**The conflict fix, provable at the pure level**: `lifecycle.test.ts` shows two devices
stopping the same timer produce sessions with *different* end times/devices but the **same
`log_id`** — exactly what the LWW reducer collapses to one, no double-count.

**Deliberately deferred to Phase 2** (where sync actually holds the record): adding `logId`
to the persisted `TimerState`/`ActiveSession` and threading it through `start()` + the
store. Phase 1 keeps `logId` an explicit parameter of the pure functions, so nothing in the
running app changed yet.

**Quality**: TS 318 tests, `tsc` + `eslint` clean. Kotlin `:core` 101 tests headless.
Checkpoint-committed separately from Phase 0.
