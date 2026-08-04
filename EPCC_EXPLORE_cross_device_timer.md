# Exploration: Cross-device active timer (record the running timer centrally)

**Date**: 2026-08-04 | **Scope**: Medium-deep | **Status**: ✅ Complete
**Branch**: `binchoi/explore-cross-device-timer` | **Phase**: EXPLORE only (no code written)

**Question from the user**: I start a timer on my MacBook / phone / wearable. The
start is stored locally only, so I can't start on one device and stop on another.
Is moving the timer's start into the spreadsheet favorable for a consistent
cross-device experience, or does it add a lot of network overhead?

**Short answer**: Favorable, and the network overhead is small — *because* of how
this timer is built (elapsed is derived from timestamps, not counted, so a single
published "start" lets any device render a correct live timer with **no
heartbeat**). The real constraints are not bandwidth; they are (1) no
background-sync, so both devices must have the app open, (2) the wearable almost
certainly can't run this PWA, and (3) a schema/migration + concurrency-semantics
decision. Details and a recommendation below.

---

## 1. Foundation — what exists today

**Tech stack**: Next.js 16 PWA, React 19, TypeScript, Dexie (IndexedDB), Zod,
Google Sheets v4 as the sync target. Service-account JWT auth (non-extractable
`CryptoKey`).

**Data model**: IndexedDB is the source of truth for the UI; the Sheet is a sync
target. Sheet tabs are **append-only logs**; reads collapse them by last-write-wins
(LWW). Three tabs: `goals` (`A:J`), `sessions` (`A:L`), `meta` (`A:B`)
(`src/lib/sheets/columns.ts:27-64`).

**The gap, precisely**: the running timer is the one piece of state that is
**device-local and never synced**.
- It lives in its own IndexedDB store `activeSession`, a singleton row `id:"current"`
  that "*is* the lock" (`src/lib/timer/store.ts:9-11`, `src/lib/store/db.ts:31-40`).
- Cross-*tab* convergence on one device is handled by a `BroadcastChannel`
  (`focus-log.timer`, `store.ts:57-64`) — **not** cross-device.
- No outbox op is ever created for it; the sync engine's `push()`/`pull()` never
  touch `activeSession`; `OutboxOp.entity` only accepts `"goal"|"session"`
  (`src/lib/store/db.ts:16-19`, `src/lib/sync/engine.ts:185-193`). Confirmed: the
  running timer's start is never pushed to nor pulled from the sheet.

**Why this is a small change conceptually**: everything needed to reconstruct a
running timer on another device is already a compact, self-contained payload — the
`ActiveSession` fields: `goal_id`, `segments[]`, `started_at`, `note` (plus
`device_id` + `updated_at`, already on the row). See §2.

---

## 2. The key insight — no heartbeat is needed

The timer never counts ticks. Elapsed is *always* derived from wall-clock
timestamps (`src/lib/timer/engine.ts:54-63`):

```
elapsed = Σ(closed segments) + (now − open-segment start)
```

A session is `segments: { start:number; end:number|null }[]` — original start =
`segments[0].start`, each pause = a segment `end`, each resume = a new segment
`start`, "currently running" = a trailing `end === null` (`engine.ts:21-84`).

**Consequence for cross-device**: if device A publishes its `segments` + `started_at`
*once per state transition*, device B calls `elapsedSeconds(state, B_now)` and shows
a correctly ticking timer with **zero further network traffic**. `pause`/`resume`/`stop`
are pure functions of `segments` + an injected `now` (`engine.ts:70-106`), so device
B can pause or end A's timer with no extra state. This is why the feature is cheap:
you sync **transitions, not a stream**.

Finalization already collapses `segments` → a `Session` row (`start_utc`, `end_utc`,
`duration_seconds`, logging *focused* time so pauses are excluded) in
`engine.stop()` + `repo.logSession()` (`engine.ts:91-106`, `src/lib/store/repo.ts:112-149`).

---

## 3. Patterns to reuse (the sync machinery already solves the hard parts)

**Append-only + LWW is a deterministic multi-writer merge with no server**
(`src/lib/sync/merge.ts`): whole-record LWW keyed on `updated_at` as an instant
(`Date.parse`), tie-broken by `device_id` lexicographically (`merge.ts:39-56`);
tombstones propagate deletes (`merge.ts:63-67`). Convergence is property-tested
(`merge.test.ts:186-240`). **This is exactly the reconciliation a shared timer
needs** ("last action wins" across devices).

**Idempotent writes**: client-minted ids + append means a lost response is at worst
a byte-identical duplicate row the reducer collapses (`engine.ts:8-12`). Repeated
edits to one entity collapse to a single outbox op (`repo.ts:213-227`).

**Outbox + leasing**: mutation writes the row *and* enqueues an outbox op in one
Dexie transaction — that transaction is the "saved" commit point, not the HTTP
response (`repo.ts:205-229`). Draining is leased, not optimistic-deleted
(`engine.ts:206-245`).

**`device_id`** is per-browser (localStorage `focus-log.device_id`,
`src/lib/store/ids.ts`), so MacBook / phone are naturally distinct owners — good for
"running on <device>". (Caveat: it's per-browser-profile, not per-hardware.)

---

## 4. Constraints that shape the design

**C1 — `meta` tab is a poor home for mutable state.** It's key/value, but the only
sheet-write path is `replaceTab` = **clear + PUT the whole tab** (2 round-trips,
`src/lib/sheets/client.ts:266-273`). There is no per-key update and no
`batchUpdate`. A clear+rewrite is **not append-idempotent and races across devices**
(two devices rewriting `meta` clobber each other; LWW can't help a full rewrite).
Also, `meta` is currently read-only at runtime — the app persists its sync cursors
to the local `syncMeta` IndexedDB store, never to the sheet (`engine.ts:260-262`).

**C2 — the `sessions` schema rejects an "open" row.** `SessionSchema` hard-requires
`end_utc` (`isoUtc`) and `duration_seconds` (int ≥ 0), with a `.refine`
`end_utc >= start_utc` (`src/lib/sheets/schema.ts:57-75`). A start-only row is
dropped as a `ParseFailure` on read. Reusing the sessions log for an in-progress
timer therefore requires relaxing the schema (optional `end_utc`/`duration` + an
explicit "open"/`status` flag) *and* teaching read-parse, merge, and every
totals/UI consumer to skip in-progress rows.

**C3 — no background sync.** Deliberately deferred in the original plan: it needs
JWT signing duplicated in the service worker (`src/lib/sync/triggers.ts:8-12`;
`EPCC_PLAN.md:127`, §2.4). So a device only publishes/receives while the **app is
open**. "Stop it from my phone" means *open the PWA on the phone* — which fires a
sync at startup (`triggers.ts:70-72`) within ~0–2s. Acceptable for "I forgot to
stop it," but it is **not** "reach into a sleeping phone."

**C4 — the wearable is effectively out of scope.** A watch almost certainly cannot
run this Next.js PWA. "Start on my watch" would require a *separate* client signing
Sheets requests (or a companion service) — a much larger project than this feature.
Flag explicitly; scope the first cut to **MacBook ↔ phone**.

**C5 — schema/migration.** A new tab or new session columns bumps `schema_version`.
The app already guards this: `isSchemaCompatible` refuses to write a sheet whose
version it doesn't match (`engine.ts:271-275`). Existing users would need to add the
tab/columns (update `sheet-template/SETUP.md` + CSVs). Plan a graceful path so an
un-migrated sheet degrades to today's local-only behavior rather than erroring.

**C6 — clock skew.** `started_at` is the originating device's clock; device B
derives elapsed with *its* clock. If clocks differ by minutes, elapsed looks off.
Usually small (NTP), but now user-visible. No server clock exists to anchor to.

**C7 — offline start.** If the starting device is offline, the start never reaches
the sheet, so it isn't visible elsewhere until that device syncs. Inherent to a
sheet-as-broker design.

---

## 5. Network overhead assessment (the user's core worry)

**Baseline already in place** (`src/lib/sync/triggers.ts`, `engine.ts`):
- Pull = **1** `batchGet` of all three tabs; whole-column ranges, **no deltas** — it
  already downloads the entire append log every pull (`client.ts:241-248`,
  `columns.ts:80-93`). This is the dominant existing cost and grows with history
  until "Compact sheet."
- Push = **0–2** batched `append` calls per cycle (goals, then sessions).
- Cadence: **60s poll** while visible+online, +`online`/`visibility`/`startup`
  events, +2s-debounced after mutations. Hidden/offline tabs don't poll. Concurrent
  triggers collapse to one in-flight run (`engine.ts:88-93`).
- Warm-token write ≈ one HTTPS round-trip (~150–500 ms). Sheets quota is 60
  writes/min/user; batching keeps us far under (`EPCC_PLAN.md:2.4`).

**Incremental cost of a cross-device timer**:
- **Reads**: cross-device pickup **piggybacks on the existing 60s poll** — add the
  active-timer range to the pull; a 4th small range in the same `batchGet` is
  negligible. No new polling infrastructure. Propagation latency ≤ ~60s (or instant
  on open/visibility), which is fine for "I forgot to stop it."
- **Writes**: only on **state transitions** — start, each pause/resume, stop. A
  handful per session, debounced/batched, trivially under quota. **No heartbeat**
  (see §2) — the single biggest reason overhead stays small.
- **The one amplifier**: if the active state is stored as *append-only* rows
  (Options B/C below), rapid pause/resume toggling appends rows → log growth. Bounded
  and compactable, or avoided with a single in-place row (Option A) at the cost of
  append-idempotency.

**Verdict**: bandwidth/quota is **not** the blocker. The design cost is concurrency
semantics + migration, not network.

---

## 6. Design options (for PLAN to decide — not decided here)

| Option | Where the active timer lives | Pros | Cons |
|---|---|---|---|
| **A. Singleton `active` row, in-place** (reserved `meta` key or a 1-row tab, updated via clear+PUT) | Mirrors the `id:"current"` lock | No log growth; conceptually 1:1 with local model | In-place write is **not idempotent and races** across devices (C1); loses the LWW safety the rest of the app relies on |
| **B. Reuse `sessions` log as an "open" row** (append start-only, finalize by appending completed row w/ same `log_id`; LWW collapses) | Maximum reuse of existing sync/merge/outbox; deterministic concurrency for free | Requires relaxing `SessionSchema` (C2) + teaching parse/merge/totals/UI about in-progress rows; blast radius across the sessions pipeline |
| **C. New append-only `active` tab** (tiny schema: `goal_id`, `segments`(JSON), `started_at`, `note`, `updated_at`, `device_id`, `closed`) reduced to a singleton by LWW | Inherits append + LWW concurrency; **isolates** change from the sessions schema/totals | New tab ⇒ `schema_version` bump + `SETUP.md`/CSV migration (C5); a little new plumbing |
| **D. Status quo** (local only) | Zero cost | Doesn't solve the user's problem |

**Leaning**: **Option C** — it keeps the proven append-only+LWW concurrency model
(unlike A's racy in-place rewrite) while isolating the change from the sessions
schema and every totals/heatmap consumer (unlike B). The price is a one-time
migration. PLAN should weigh C vs B explicitly.

**Concurrency semantics to nail down in PLAN** (all expressible with existing LWW):
- Each transition bumps `updated_at`; whole-record LWW ⇒ "last action wins"
  (intuitive: a phone `pause` after a Mac `resume` wins if later).
- Any device may pause/stop. When device B stops A's timer, B appends the finalized
  `Session` and closes/clears the active pointer.
- Stale/abandoned timer (device starts then vanishes): resolved when another device
  ends it; also reuse the existing `restore()` `long`/`too_long` guardrails
  (`engine.ts:120-159`) to prompt auto-closing an implausibly long run.
- Reconcile the **type mismatch**: `activeSession` uses epoch-ms numbers;
  `Goal`/`Session.updated_at` are ISO-8601 strings (agent-confirmed). Pick one on the
  wire.

---

## 7. Handoff

**Recommendation to the user**: Yes — recording the timer centrally is a good,
low-overhead way to get a consistent MacBook ↔ phone experience, and the
timestamp-derived engine means it costs a few small writes per session and rides the
existing 60s poll (no heartbeat, no new polling). Proceed — but scope it honestly:
- **In scope**: MacBook ↔ phone, both with the PWA open; live "running on <device>
  since <time>"; pause/stop from any device; stale-timer guardrails.
- **Defer/flag**: the **wearable** (needs a separate client — out of scope, C4) and
  **background-sync-while-closed** (needs SW-side JWT — C3). Set expectations that
  "stop from my phone" means opening the app on the phone.

**For PLAN**:
- Choose storage: recommend **Option C** (dedicated append-only `active` tab) over B
  (session-schema relaxation) or A (racy in-place meta rewrite); justify vs B.
- Specify concurrency rules (LWW transitions, ownership, finalize-from-any-device,
  stale handling) and the on-the-wire timestamp/segments encoding.
- Plan the `schema_version` bump + `SETUP.md`/CSV migration and the graceful
  degradation for un-migrated sheets (lean on `isSchemaCompatible`).
- Decide propagation-latency UX (accept ≤60s poll, or add a shorter poll only while a
  remote timer is known to be running).

**For CODE**: reuse `engine.ts` pure functions verbatim; extend `SyncEngine` pull to
read the active range and push a new outbox entity; keep the `BroadcastChannel` for
same-device tabs; add e2e mirroring `sync.spec.ts` (two contexts = two devices).

**Gaps / open questions for the user**:
- Is MacBook ↔ phone enough for v1, with the wearable explicitly deferred?
- Acceptable for cross-device stop to take up to ~60s to reflect (vs. adding a faster
  poll while a remote timer is active)?
- Comfortable with a one-time spreadsheet migration (new `active` tab)?

**Tooling** (verified this session): `npm run test` (285 unit), `npx playwright test`
(e2e; prod build on :3000), `npm run lint`, `npm run typecheck`.

---

## 8. Update after pulling `main`: the wearable is here, and it's a *duplicated* core

`main` now contains `focus-log-wear/` — a native **Wear OS 5 (Kotlin)** companion
for the Galaxy Watch Ultra. Its `:core` module (`focus-log-wear/core/…`) is a
**hand-port of the web app's pure modules**, not a shared package:

- `timer/TimerEngine.kt` — "a **line-for-line port** of the web app's
  `timer/engine.ts`" (same `elapsed = Σ closed + (now − open)`, same `stop()` logging
  focused duration).
- `sync/Merge.kt` — "a **port** of the web app's `sync/merge.ts`": identical LWW
  (compare `updatedAt` as a parsed instant, tie-break `deviceId`, `reduceLatest` by
  id, tombstones kept).
- `model/Records.kt` — `Session`/`Goal` "**mirrored from** `sheets/schema.ts`" with
  the same fields; snake_case wire names in `sheets/Columns.kt`.
- README: "the watch is just another `device_id` in the existing append-only +
  last-write-wins protocol"; "`:core` … is **transliterated** from the web app's pure
  modules with the **TS tests ported verbatim** as the spec."

So there are now **two independent implementations of the same protocol** (TS +
Kotlin), kept aligned by discipline and duplicated tests — not by a shared artifact.
This directly bears on both of the user's questions below.

### 8a. Conflict: two devices end the *same* central timer at different times

**The real bug is not the end time — it's the id.** Both platforms mint a **fresh
`log_id` at *stop*** (`repo.ts` `log_id: newId()`; `Repo.kt` `logId = ids()`), and the
merge reducer collapses the append log **by `log_id`**. So if two devices each
finalize one shared running timer, they emit **two different `log_id`s** → the
reducer treats them as two unrelated sessions → the focus period is **double-counted**.
Whole-record LWW does *not* help, because LWW only dedupes rows that share an id.

The user's idea — "take the latter of the session ids that ended" — is the right
instinct (reconcile in the event log) but hits a wall: two *different* ids carry **no
shared key** tying them to the same focus period, so the log would have to *guess*
they're the same (same goal + overlapping interval) — exactly the ad-hoc,
sheet-side/Apps-Script reconciliation we want to avoid.

**Recommended fix — make it one id, and the existing log reconciles it for free:**

1. **Mint the session `log_id` at START, not at stop.** Publish it in the shared
   active-timer record (§6). Whichever device finalizes writes the completed row
   under **that same id**.
2. Two devices ending it now produce **two rows with the *same* `log_id`**, differing
   only in `end_utc` / `duration_seconds` / `updated_at`. The **existing
   `reduceLatest` LWW collapses them to one** — no new reconciliation code, no server,
   no Apps Script, no sheet formulas. This is precisely "reconcile via the event log,"
   done with a real correlation key instead of a guess.
3. **Reduce the race up front:** on stop, the finalizing device clears/tombstones the
   shared active record. Other devices, on their ~60s poll, see it closed and
   reconcile their local running timer to the logged session **instead of finalizing
   again**. So a genuine double-finalize is only the narrow window where both stop
   within one poll cycle — and even then step 2 makes it converge.

**Remaining choice = the tiebreak *semantic*** (which end wins when both rows share the
id). All are deterministic and server-free:
- **(default) LWW on `updated_at`** — last write to reach the sheet wins. Zero new code;
  already implemented on both platforms. Downside: "last to write" ≠ "correct end,"
  but in the real "I forgot to stop it" case only one device truly stops, and when
  both stop they do so within seconds, so the totals differ negligibly.
- **First-close-wins / earliest `end_utc`** — a close is terminal; the first honest stop
  is the truth. More intuitive, but fights LWW's "last wins" and needs a small domain
  rule (prefer a closed row; between closes, smaller `end_utc`).
- **Largest `duration_seconds`** — conservative "count the most focus." Rarely what you
  want.

**Recommendation**: ship the **start-minted shared id + plain LWW** first (it's the
minimal change that makes the log converge and eliminates double-counting), and only
add a domain tiebreak (first-close-wins) later if the arbitrariness ever bothers you.
Note the sibling conflict — two devices *starting* concurrently — is resolved by the
single active-lock record (`id:"current"`) under the same LWW: one owner wins; the
loser's start is surfaced ("a session is already running") rather than silently
double-logged. Worth specifying in PLAN, but out of scope for the two-ends question.

### 8b. Is the duration/total logic centralized in a shared package? (No.)

**No — it's duplicated across two runtimes on purpose.** The web computes
duration/elapsed/LWW in TypeScript (`focus-log/src/lib/{timer,sync,stats}`); the watch
recomputes the same in Kotlin (`focus-log-wear/core`), as a transliteration with the
TS tests ported verbatim. They agree today only because a human kept them in step.

**Should we centralize?** The runtimes are genuinely different (browser TS/React vs
Android JVM/Kotlin), so there is no zero-cost shared module. Three routes:

- **A. Kotlin Multiplatform (KMP)** — write `core` once in Kotlin, compile to JVM
  (watch) + JS (web). Truly one source of truth, but a **large** change: the TS/React
  app would consume a KMP-JS artifact, retool its build, and give up idiomatic TS/zod.
  Overkill while the wearable is deliberately small.
- **B. Status quo (two idiomatic cores, ported tests)** — lowest friction, idiomatic on
  each side, but **drift risk**: a column reorder, a different LWW tiebreak, or
  different duration rounding on one platform silently breaks cross-device convergence.
- **C. (Recommended) Shared *conformance contract*, not shared code.** Keep the two
  idiomatic cores, but pin the parts that **must** agree byte-for-byte — the wire
  contract — as **language-neutral golden test vectors** (JSON: input rows →
  expected reduced/merged output; timer segment sets → expected elapsed/duration; the
  exact LWW ordering incl. `updated_at`-as-instant + `deviceId` tiebreak; column order
  & row codec). **Both** the Vitest and the `:core` JUnit suites load the same vectors
  and assert against them. This catches the drift that actually causes cross-device
  bugs, at a fraction of KMP's cost, without forcing a shared runtime.

Because the **cross-device-timer protocol is new** (start-minted shared id, active-record
shape, close/clear semantics, the chosen tiebreak), it should be defined **once in that
shared conformance contract** and implemented against it on **all three** clients — so
the reconciliation rule is provably identical everywhere. That is the single most
important safeguard for the feature: LWW only converges if every device computes the
*same* "winner."

### 8c. Revised handoff for PLAN

- Adopt **start-minted shared `log_id`** as the backbone of the cross-device timer;
  it makes §6's storage options collapse-correct and answers the two-ends conflict with
  the existing reducer.
- Pick the tiebreak semantic (default LWW; optional first-close-wins) and write it into
  a **shared conformance-vector suite** consumed by both the TS and Kotlin cores.
- Treat the wire contract (schema/codec/merge-order/timestamp + the new active-record)
  as the interop boundary; do **not** pursue full KMP now.
