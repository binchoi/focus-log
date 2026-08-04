package com.focuslog.wear.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.focuslog.wear.FocusLogApp
import com.focuslog.wear.sync.SyncScheduler

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val graph = (application as FocusLogApp).graph
        setContent {
            FocusTheme {
                FocusApp(graph)
            }
        }
    }

    /**
     * Sync every time the app comes to the foreground, so glancing at the watch
     * shows fresh data instead of whatever the last ~30-minute periodic sync left.
     * The periodic worker keeps the background fresh; this makes "open the app"
     * feel live, which matters most for the cross-device timer.
     */
    override fun onStart() {
        super.onStart()
        val graph = (application as FocusLogApp).graph
        if (graph.isConfigured) SyncScheduler.syncNow(this)
    }
}
