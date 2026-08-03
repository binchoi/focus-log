package com.focuslog.wear.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.focuslog.wear.FocusLogApp

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
}
