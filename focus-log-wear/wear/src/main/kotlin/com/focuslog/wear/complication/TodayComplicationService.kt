package com.focuslog.wear.complication

import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import com.focuslog.core.time.Time
import com.focuslog.wear.AppGraph

/**
 * A SHORT_TEXT complication showing today's focused total on the watch face.
 *
 * NOTE: not compiled in headless CI (:wear needs the Android SDK). Verify on
 * device; the complications-data-source APIs are stable but the exact builder
 * signatures can shift between library versions.
 */
class TodayComplicationService : SuspendingComplicationDataSourceService() {

    override fun getPreviewData(type: ComplicationType): ComplicationData =
        shortText("1h 20m")

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData {
        val graph = AppGraph.get(applicationContext)
        val today = Time.localDateOf(System.currentTimeMillis(), Time.currentTimeZone())
        val seconds = graph.store.allSessions()
            .filter { !it.deleted && it.localDate == today }
            .sumOf { it.durationSeconds.toLong() }
        return shortText(Time.formatTotal(seconds))
    }

    private fun shortText(text: String): ShortTextComplicationData {
        val content = PlainComplicationText.Builder(text).build()
        return ShortTextComplicationData.Builder(
            text = content,
            contentDescription = PlainComplicationText.Builder("Focused today: $text").build(),
        ).build()
    }
}
