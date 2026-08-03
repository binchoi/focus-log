package com.focuslog.wear.data.config

import android.content.Context
import org.json.JSONObject

/**
 * The embedded credential + spreadsheet id, read once from
 * `assets/focus-config.json`. Loaded by filename (not R.raw) so the project
 * compiles without the secret present — a fresh checkout runs in an
 * "unconfigured" state and shows a setup hint rather than failing to build.
 *
 * See wear/README.md for how the key gets onto the watch and the honest security
 * trade-off of embedding it.
 */
data class AppConfig(
    val spreadsheetId: String,
    val clientEmail: String,
    val privateKeyPem: String,
) {
    companion object {
        private const val FILE = "focus-config.json"

        /** Returns null when the config asset is absent or a placeholder. */
        fun load(context: Context): AppConfig? {
            val text = runCatching {
                context.assets.open(FILE).bufferedReader().use { it.readText() }
            }.getOrNull() ?: return null

            return runCatching {
                val root = JSONObject(text)
                val sa = root.getJSONObject("serviceAccount")
                val config = AppConfig(
                    spreadsheetId = root.getString("spreadsheetId"),
                    clientEmail = sa.getString("client_email"),
                    privateKeyPem = sa.getString("private_key"),
                )
                // Guard against shipping the committed placeholder by mistake.
                if (config.spreadsheetId.startsWith("PASTE_") ||
                    config.privateKeyPem.contains("ExampleFakeKey")
                ) {
                    null
                } else {
                    config
                }
            }.getOrNull()
        }
    }
}
