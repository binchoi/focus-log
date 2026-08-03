# The embedded credential

The watch authenticates to Google Sheets with a **service-account key**, embedded
in the app and loaded at runtime from `wear/src/main/assets/focus-config.json`.

## Setup

1. Copy the template:
   ```
   cp wear/src/main/assets/focus-config.example.json \
      wear/src/main/assets/focus-config.json
   ```
2. Fill it in:
   ```json
   {
     "spreadsheetId": "the long id between /d/ and /edit in the sheet URL",
     "serviceAccount": {
       "client_email": "focus-log@your-project.iam.gserviceaccount.com",
       "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
     }
   }
   ```
   Use the **same** service account whose key the PWA uses, and make sure it is
   shared on the spreadsheet as an **Editor**.
3. Rebuild. `focus-config.json` is gitignored, so your key is never committed. The
   committed `*.example.json` is only a template.

If the file is absent or still the placeholder, the app runs in an *unconfigured*
state: the timer and local store work fully, but nothing syncs.

## The honest security note

This mirrors the trade-off chosen for the PWA, and its documented limit applies
here too:

- The key is bundled **inside the APK** (in `assets/`). Anyone who has the APK can
  extract it. For a single-user app you build yourself and never distribute, the
  realistic exposure is "someone has your unlocked watch *and* pulls app storage."
- The `1234` PIN (`APP_PIN` in `ui/FocusApp.kt`) is a convenience gate — it stops a
  casual tap, not a determined extractor. Your watch's **device lock** is the real
  first line of defence.
- The key has `auth/spreadsheets` scope and does not expire. If it ever leaks,
  **rotate the service account** in the Google Cloud console — one click, and the
  old key is dead.

### Hardening (optional, on-device follow-up)

The plan's stronger option is to import the key into the **AndroidKeyStore** as
non-exportable on first launch (the hardware analogue of the PWA's
`extractable: false`), then delete the embedded asset. That keeps the key
unreadable at rest even if storage is dumped. Importing an externally-generated
RSA key into the Keystore requires wrapping it in a self-signed certificate
(BouncyCastle `bcpkix`), which is why it's left as a verified-on-device follow-up
rather than shipped untested — see the note in `data/auth/Jwt.kt`. The current
`Rs256Signer` signs with the parsed key directly, which is functionally identical
for signing and keeps the key off any server and out of logs.
