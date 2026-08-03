package com.focuslog.wear.data

import android.content.Context

/**
 * The app-lock policy: enter the PIN once, and it stays unlocked for 24 hours.
 *
 * This is a convenience gate, not a security boundary — the embedded key's real
 * protection is the watch's own device lock (see wear/README.md). Caching the
 * unlock keeps the PIN from nagging on every glance while still requiring it
 * daily.
 */
object AppLock {
    private const val PREFS = "focus_lock"
    private const val KEY_LAST_UNLOCK = "last_unlock_at"
    private const val TTL_MS = 24L * 60 * 60 * 1000

    fun isUnlocked(context: Context, now: Long = System.currentTimeMillis()): Boolean {
        val last = prefs(context).getLong(KEY_LAST_UNLOCK, 0L)
        return last > 0 && now - last < TTL_MS
    }

    fun markUnlocked(context: Context) {
        prefs(context).edit().putLong(KEY_LAST_UNLOCK, System.currentTimeMillis()).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
