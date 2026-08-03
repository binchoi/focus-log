package com.focuslog.wear.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme

/** The "Instrument" palette from the PWA, pared down for the watch. */
@Composable
fun FocusTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colors = Colors(
            primary = Color(0xFFFF7A18),      // ember
            primaryVariant = Color(0xFFC85A0E),
            secondary = Color(0xFFF5EFE6),     // cream
            background = Color(0xFF0B0A09),     // ink
            surface = Color(0xFF16130F),
            onPrimary = Color(0xFF0B0A09),
            onBackground = Color(0xFFF5EFE6),
            onSurface = Color(0xFFF5EFE6),
            onSurfaceVariant = Color(0xFFB8AE9E),
        ),
        content = content,
    )
}
