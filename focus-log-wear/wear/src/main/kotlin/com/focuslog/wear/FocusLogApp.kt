package com.focuslog.wear

import android.app.Application
import com.focuslog.wear.sync.SyncScheduler

class FocusLogApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph.get(this)
        // Drain the outbox and pull remote changes on a periodic cadence; the
        // watch is offline often, so opportunistic sync matters more than speed.
        if (graph.isConfigured) SyncScheduler.schedulePeriodic(this)
    }
}
