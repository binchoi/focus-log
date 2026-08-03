package com.focuslog.core.time

import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * Time handling — a port of `time.ts`.
 *
 * We keep two things that cannot be derived from each other after the fact: an
 * absolute instant (ISO-8601 UTC) for arithmetic, and the calendar date as the
 * user experienced it plus the IANA zone, for correct day grouping. All instants
 * cross the boundary as epoch milliseconds.
 */
object Time {

    // Always millisecond-precise + 'Z', matching the sheet schema regex and the
    // web app's Date.toISOString(). Instant.toString() would drop a zero
    // millisecond field ("…:00Z"), which is a different string for the same
    // moment — harmless after parsing, but we keep the canonical form on write.
    private val ISO_UTC: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** Serialise an instant for storage. Always UTC, always millisecond-precise. */
    fun toIsoUtc(epochMillis: Long): String = ISO_UTC.format(Instant.ofEpochMilli(epochMillis))

    /** The device's current IANA timezone, e.g. `Asia/Singapore`. */
    fun currentTimeZone(): String = ZoneId.systemDefault().id

    /**
     * The calendar date of `epochMillis` as seen in `timeZone`. Attributing a
     * session to the day it *started*, in the zone the user was in, is what makes
     * "what did I do on Tuesday" answerable after a timezone change.
     */
    fun localDateOf(epochMillis: Long, timeZone: String): String =
        Instant.ofEpochMilli(epochMillis).atZone(ZoneId.of(timeZone)).toLocalDate().toString()

    /**
     * Whole seconds between two instants. Deliberately *not* floored to minutes:
     * the old app threw away up to 59s on every session, biased downward.
     */
    fun durationSeconds(startMillis: Long, endMillis: Long): Long =
        ((endMillis - startMillis).toDouble() / 1000.0).roundToLong()

    /** Format seconds as `H:MM:SS`, or `M:SS` under an hour. */
    fun formatDuration(totalSeconds: Long): String {
        val sign = if (totalSeconds < 0) "-" else ""
        val s = abs(totalSeconds)
        val hours = s / 3600
        val minutes = (s % 3600) / 60
        val seconds = s % 60
        val mm = minutes.toString().padStart(2, '0')
        val ss = seconds.toString().padStart(2, '0')
        // Roll into hours so a 2h05m session never renders as "122:05".
        return if (hours > 0) "$sign$hours:$mm:$ss" else "$sign$minutes:$ss"
    }

    /** Human-friendly total, e.g. `2h 5m`. Used for goal and day totals. */
    fun formatTotal(totalSeconds: Long): String {
        val s = maxOf(0L, totalSeconds)
        if (s == 0L) return "0m"
        // Under a minute is real work but rounds to zero; say so explicitly.
        if (s < 60) return "<1m"
        // Round to whole minutes first, then split — splitting first lets 3570s
        // render as "1h 60m".
        val totalMinutes = ((s.toDouble()) / 60.0).roundToLong()
        val hours = totalMinutes / 60
        val minutes = totalMinutes % 60
        return when {
            hours == 0L -> "${minutes}m"
            minutes == 0L -> "${hours}h"
            else -> "${hours}h ${minutes}m"
        }
    }
}
