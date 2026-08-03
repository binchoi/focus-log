# Focus Log — Wear OS companion

A native **Wear OS 5** quick-capture companion for the Galaxy Watch Ultra: unlock
with a PIN, glance at today's total, tap a goal, start/pause/finish a focus timer.
Sessions sync to the **same Google Sheet** the [PWA](../focus-log) uses — the watch
is just another `device_id` in the existing append-only + last-write-wins protocol.

The heavy stuff (stats, editing, goal management, setup) stays on the phone/desktop
PWA. This app is deliberately small.

## Modules

| Module | What | Build/verify |
|---|---|---|
| **`:core`** | Pure-JVM Kotlin: timer engine, LWW merge, sheet schema/codec, time, repo/outbox, sync engine | `./gradlew :core:test` — **runs headless, 82 tests** |
| **`:wear`** | Android Wear OS app: Room, Keystore/JWT auth, OkHttp Sheets client, WorkManager sync, Compose UI, foreground service, Tile, complication | Build & run in **Android Studio** on the watch |

`:core` is where the correctness lives; it's transliterated from the web app's
pure modules with the TS tests ported verbatim as the spec. `:wear` is thin
Android glue over it. `:wear` is only included in the Gradle build when an Android
SDK is present (see `settings.gradle.kts`), so `:core` stays runnable in headless
CI.

## Build & sideload to your watch

1. **Open `focus-log-wear/` in Android Studio** (Ladybug or newer). Let it sync;
   accept any prompt to install the required SDK / build-tools. It creates
   `local.properties` with your `sdk.dir`, which flips on the `:wear` module.
2. **Add your credential** — see [`wear/README.md`](wear/README.md). Without it the
   app still runs (lock screen + empty goal list); sync is simply disabled.
3. **Enable developer mode on the watch**: Settings → About → Software → tap the
   version repeatedly; then Settings → Developer options → **ADB debugging** +
   **Debug over Wi-Fi**.
4. **Pair**: `adb connect <watch-ip>:<port>` (shown on the watch), or use Android
   Studio's Wi-Fi pairing.
5. **Run** the `wear` configuration. It installs and launches on the watch.

No Play Store, no `$25` account — sideloading to your own device is free.

## Verifying convergence (the real acceptance test)

With the watch and the PWA pointed at the same spreadsheet:
- Log a session on the watch **in airplane mode** → re-enable network → it appears
  in the PWA after sync (outbox drains).
- Create/archive a goal in the PWA → it shows up on the watch after a pull.
- Start a timer, let the screen sleep for a while → the elapsed time is correct on
  return (derived from timestamps, not ticks).

## Status of each phase

- **Phases 1–3 (logic, store, sync, auth, client):** implemented; the pure half is
  unit-tested (`:core`, 82 tests). The Android half compiles against the SDK in
  Studio.
- **Phase 4 (UI + foreground service):** implemented; verify on device.
- **Phase 5 (Tile + complication):** implemented but **minimal and unverified** —
  the protolayout/complications APIs are version-sensitive; adjust versions in
  `gradle/libs.versions.toml` if Studio's sync flags a mismatch.
- **Keystore hardening:** the signer currently signs with the parsed key directly
  (functionally identical to the PWA's non-extractable key, and off any server).
  Importing the key into the AndroidKeyStore as non-exportable needs a self-signed
  cert wrapper (BouncyCastle) and is a documented on-device follow-up. See
  `wear/data/auth/Jwt.kt`.

## Versions

Pinned in `gradle/libs.versions.toml`: Kotlin 2.1.0, AGP 8.7.3, Gradle 8.11.1
(wrapper), compileSdk 35 / minSdk 33 / targetSdk 34. Android Studio may suggest
newer AGP/library versions on first sync — accept or adjust in the catalog.
