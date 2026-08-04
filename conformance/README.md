# Cross-core conformance vectors

Language-neutral golden vectors that pin the **web (TypeScript)** and **Wear OS
(Kotlin)** cores to identical behaviour. Both test suites load these same JSON
files and assert against them, so if one core drifts — a different LWW tiebreak, a
rounding change in elapsed, a segments-encoding mismatch — its CI fails.

This matters because the whole cross-device design is server-free last-write-wins:
convergence only holds if **every** client computes the *same* winner and the
*same* elapsed/duration.

| File | Pins | Consumed by |
|---|---|---|
| `elapsed.json` | `elapsedSeconds(segments, now)` — derived from timestamps, floored | `engine.ts` / `TimerEngine.kt` |
| `lww.json` | `compareVersions` / `pickWinner` — later `updated_at` wins, `device_id` tiebreak | `merge.ts` / `Merge.kt` |
| `segments-codec.json` | `encode`/`decode` of the `active` tab's `segments` cell (incl. rejects) | `schema.ts` / `RowCodec.kt` |
| `active-mapping.json` | `runningActive`/`closedActive`/`finalizedSession` — active row ↔ timer ↔ finalized session | `lifecycle.ts` / `Lifecycle.kt` |

**Encoding conventions**

- Segments are `[startMs, endMs]` pairs; a running (open) segment is `[startMs, null]`.
- `winner` is `"a"` or `"b"` — the record `pickWinner(a, b)` must return (ties → `a`).
- Timestamps are epoch **milliseconds** in `elapsed.json`; ISO-8601 UTC strings in `lww.json`.

Loaders: TS `focus-log/src/lib/conformance.test.ts`, Kotlin
`focus-log-wear/core/src/test/kotlin/com/focuslog/core/ConformanceTest.kt`.
