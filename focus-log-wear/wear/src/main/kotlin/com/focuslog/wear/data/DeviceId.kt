package com.focuslog.wear.data

import android.content.Context
import java.util.UUID

/**
 * A stable per-install id for this watch, used as the `device_id` tie-breaker in
 * the last-write-wins merge. It must be stable across launches (so this device
 * always resolves conflicts the same way) and distinct from every other device
 * writing to the sheet — hence the `wear-` prefix and a random UUID persisted on
 * first run.
 */
object DeviceId {
    private const val PREFS = "focus_log_device"
    private const val KEY = "device_id"

    fun get(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY, null)?.let { return it }
        val id = "wear-${UUID.randomUUID()}"
        prefs.edit().putString(KEY, id).apply()
        return id
    }
}
