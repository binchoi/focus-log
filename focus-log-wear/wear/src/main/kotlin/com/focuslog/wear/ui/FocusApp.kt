package com.focuslog.wear.ui

import android.view.HapticFeedbackConstants
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CompactChip
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.focuslog.core.model.Goal
import com.focuslog.core.time.Time
import com.focuslog.core.timer.StopResult
import com.focuslog.core.timer.TimerEngine
import com.focuslog.core.timer.TimerPhase
import com.focuslog.wear.AppGraph
import com.focuslog.wear.data.AppLock
import com.focuslog.wear.sync.SyncScheduler
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Palette (mirrors the PWA "Instrument" system).
private val Ember = Color(0xFFFF7A18)
private val Ink = Color(0xFF0B0A09)
private val Cream = Color(0xFFF5EFE6)
private val Muted = Color(0xFF9C9081)
private val Key = Color(0xFF211D18)
private val Danger = Color(0xFFE5484D)

private enum class Screen { LOCK, GOALS, TIMER }

/**
 * The whole watch UI. Navigation is one piece of state — this is a quick-capture
 * app, not a browser. The PIN gate caches for 24h (see [AppLock]).
 */
@Composable
fun FocusApp(graph: AppGraph) {
    val context = LocalContext.current
    var unlocked by rememberSaveable { mutableStateOf(AppLock.isUnlocked(context)) }
    var openGoalId by rememberSaveable { mutableStateOf<String?>(null) }

    // Resume a session that was running when the app last closed.
    LaunchedEffect(Unit) {
        val restored = graph.timer.load()
        if (restored != null) openGoalId = restored.goalId
    }

    val listState = rememberScalingLazyListState()
    val screen = when {
        !unlocked -> Screen.LOCK
        openGoalId != null -> Screen.TIMER
        else -> Screen.GOALS
    }

    Scaffold(
        timeText = { if (screen != Screen.LOCK) TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = {
            if (screen == Screen.GOALS) PositionIndicator(scalingLazyListState = listState)
        },
    ) {
        when (screen) {
            Screen.LOCK -> LockScreen(onUnlock = {
                AppLock.markUnlocked(context)
                unlocked = true
            })
            Screen.TIMER -> TimerScreen(graph, openGoalId!!, onExit = { openGoalId = null })
            Screen.GOALS -> GoalListScreen(graph, listState, onOpenGoal = { openGoalId = it })
        }
    }
}

// ---------------------------------------------------------------------------
// Lock — a compact numeric keypad that fits without scrolling
// ---------------------------------------------------------------------------

private const val APP_PIN = "1234"
private val KEY_SIZE = 40.dp

@Composable
private fun LockScreen(onUnlock: () -> Unit) {
    val view = LocalView.current
    var entry by remember { mutableStateOf("") }
    var error by remember { mutableStateOf(false) }

    fun press(digit: String) {
        if (entry.length >= APP_PIN.length) return
        view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
        error = false
        entry += digit
        if (entry.length == APP_PIN.length) {
            if (entry == APP_PIN) {
                view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                onUnlock()
            } else {
                view.performHapticFeedback(HapticFeedbackConstants.REJECT)
                error = true
                entry = ""
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = if (error) "Try again" else "Enter PIN",
            style = MaterialTheme.typography.caption2,
            color = if (error) Danger else Muted,
        )
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            repeat(APP_PIN.length) { i -> PinDot(filled = i < entry.length, error = error) }
        }
        Spacer(Modifier.height(10.dp))

        for (row in listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"))) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { d -> KeyButton(d) { press(d) } }
            }
            Spacer(Modifier.height(5.dp))
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Spacer(Modifier.size(KEY_SIZE))
            KeyButton("0") { press("0") }
            KeyGlyphButton(onClick = {
                if (entry.isNotEmpty()) {
                    view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    entry = entry.dropLast(1)
                }
            }) { Text("⌫", style = MaterialTheme.typography.title3, color = Muted) }
        }
    }
}

@Composable
private fun PinDot(filled: Boolean, error: Boolean) {
    val color = when {
        error -> Danger
        filled -> Ember
        else -> Key
    }
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}

@Composable
private fun KeyButton(label: String, onClick: () -> Unit) {
    KeyGlyphButton(onClick) {
        Text(label, style = MaterialTheme.typography.title2, color = Cream)
    }
}

@Composable
private fun KeyGlyphButton(onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier.size(KEY_SIZE).clip(CircleShape).background(Key).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

@Composable
private fun GoalListScreen(graph: AppGraph, listState: ScalingLazyListState, onOpenGoal: (String) -> Unit) {
    val view = LocalView.current
    val today = remember { Time.localDateOf(System.currentTimeMillis(), Time.currentTimeZone()) }

    val goals by graph.queries.visibleGoals().collectAsState(initial = emptyList())
    val todaySessions by graph.queries.sessionsOnDate(today).collectAsState(initial = emptyList())

    val totals = todaySessions.groupBy { it.goalId }
        .mapValues { (_, s) -> s.sumOf { it.durationSeconds.toLong() } }
    val todayTotal = todaySessions.sumOf { it.durationSeconds.toLong() }

    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize(),
        state = listState,
        horizontalAlignment = Alignment.CenterHorizontally,
        // Disable auto-centering so the header rests near the top (just below the
        // clock) instead of drifting to the vertical middle with dead space above.
        autoCentering = null,
        verticalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(start = 10.dp, end = 10.dp, top = 34.dp, bottom = 40.dp),
    ) {
        item {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                // Extra breathing room between the total and the goal list.
                modifier = Modifier.padding(bottom = 12.dp),
            ) {
                Text("Focused today", style = MaterialTheme.typography.caption1, color = Muted)
                Text(
                    Time.formatTotal(todayTotal),
                    style = MaterialTheme.typography.title1,
                    color = if (todayTotal > 0) Cream else Muted,
                )
            }
        }

        if (goals.isEmpty()) {
            item {
                Text(
                    text = if (graph.isConfigured) "No goals yet.\nAdd one on your phone."
                    else "Not set up.\nAdd focus-config.json.",
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.body2,
                    color = Muted,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 12.dp),
                )
            }
        } else {
            items(goals) { goal ->
                GoalChip(goal, totals[goal.goalId] ?: 0L) {
                    view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                    // Navigate only; the timer screen starts the session in its own
                    // scope so navigation can't cancel the start (the "stuck 0:00" bug).
                    onOpenGoal(goal.goalId)
                }
            }
        }
    }
}

@Composable
private fun GoalChip(goal: Goal, todaySeconds: Long, onClick: () -> Unit) {
    Chip(
        modifier = Modifier.fillMaxWidth(),
        onClick = onClick,
        colors = ChipDefaults.secondaryChipColors(),
        label = { Text(goal.title, maxLines = 1) },
        secondaryLabel = {
            Text(
                if (todaySeconds > 0) "${Time.formatTotal(todaySeconds)} today" else "Tap to focus",
                color = Muted,
            )
        },
    )
}

// ---------------------------------------------------------------------------
// Timer + finish confirmation
// ---------------------------------------------------------------------------

@Composable
private fun TimerScreen(graph: AppGraph, goalId: String, onExit: () -> Unit) {
    val scope = rememberCoroutineScope()
    val state by graph.timer.state.collectAsState()

    // Start (or keep) this goal's session from the timer screen's own scope, so a
    // fast navigation can't cancel it mid-flight. This is what fixes the timer
    // occasionally sticking on "Paused 0:00" — and it self-heals an install that
    // was already stuck, since entering the screen re-establishes a session.
    LaunchedEffect(goalId) { graph.timer.start(goalId) }

    // While the timer screen is open, poll the sheet so a shared timer stays live
    // and a stop from another device shows up within a few seconds. The effect is
    // cancelled when you leave the screen, so it never runs in the background.
    LaunchedEffect(Unit) {
        while (true) {
            delay(15_000)
            if (graph.isConfigured) SyncScheduler.syncNow(graph.appContext)
        }
    }

    val belongsHere = state?.goalId == goalId
    val phase = if (belongsHere) TimerEngine.phaseOf(state) else TimerPhase.IDLE
    val running = phase == TimerPhase.RUNNING

    val goals by graph.queries.visibleGoals().collectAsState(initial = emptyList())
    val title = goals.firstOrNull { it.goalId == goalId }?.title ?: "Focus"

    var pending by remember { mutableStateOf<StopResult?>(null) }

    if (pending != null) {
        FinishScreen(
            recordedSeconds = pending!!.seconds,
            onConfirm = { seconds ->
                scope.launch {
                    val p = pending!!
                    graph.repo.logSession(
                        goalId = goalId,
                        startMillis = p.startMillis,
                        endMillis = p.endMillis,
                        note = p.note,
                        durationSecondsOverride = seconds,
                        // Reuse the id minted at start (here or on another device), so
                        // two devices ending this timer collapse to one session.
                        logId = graph.timer.state.value?.logId,
                    )
                    graph.timer.discard()
                    if (graph.isConfigured) SyncScheduler.syncNow(graph.appContext)
                    pending = null
                    onExit()
                }
            },
            onDiscard = {
                scope.launch { graph.timer.discard(); pending = null; onExit() }
            },
        )
        return
    }

    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(running) {
        while (running) {
            nowMs = System.currentTimeMillis()
            delay(1000)
        }
    }
    val elapsed = if (belongsHere) TimerEngine.elapsedSeconds(state, nowMs) else 0L

    Column(
        modifier = Modifier.fillMaxSize().padding(top = 26.dp, bottom = 14.dp, start = 14.dp, end = 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, maxLines = 1, style = MaterialTheme.typography.caption1, color = Muted)
        Text(
            Time.formatDuration(elapsed),
            style = MaterialTheme.typography.display2,
            color = if (running || phase == TimerPhase.PAUSED) Cream else Muted,
        )
        Text(
            when {
                running -> "Focusing"
                phase == TimerPhase.PAUSED -> "Paused"
                else -> "Starting…"
            },
            style = MaterialTheme.typography.caption2,
            color = if (running) Ember else Muted,
        )
        Spacer(Modifier.height(14.dp))

        Row(
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = { scope.launch { if (running) graph.timer.pause() else graph.timer.resume() } },
                colors = ButtonDefaults.secondaryButtonColors(),
                modifier = Modifier.size(48.dp),
            ) { if (running) PauseGlyph(Cream) else PlayGlyph(Cream) }

            Button(
                onClick = { scope.launch { pending = graph.timer.stop() } },
                colors = ButtonDefaults.primaryButtonColors(),
                modifier = Modifier.size(56.dp),
            ) { StopGlyph(Ink) }
        }
    }
}

/**
 * Confirm-and-adjust before logging. The crown steps the minutes; ± are the
 * touch fallback. Mirrors the PWA's finish dialog.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun FinishScreen(recordedSeconds: Long, onConfirm: (Long) -> Unit, onDiscard: () -> Unit) {
    val view = LocalView.current
    // Round to nearest minute, at least 0.
    var minutes by remember { mutableStateOf(((recordedSeconds + 30) / 60).toInt().coerceAtLeast(0)) }
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    fun step(delta: Int) {
        val next = (minutes + delta).coerceIn(0, 24 * 60)
        if (next != minutes) {
            minutes = next
            view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(top = 22.dp, bottom = 12.dp, start = 12.dp, end = 12.dp)
            .onRotaryScrollEvent { e ->
                step(if (e.verticalScrollPixels > 0) 1 else -1)
                true
            }
            .focusRequester(focusRequester)
            .focusable(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Log session?", style = MaterialTheme.typography.caption1, color = Muted)
        Spacer(Modifier.height(6.dp))
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StepButton("−") { step(-1) }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("$minutes", style = MaterialTheme.typography.display3, color = Cream)
                Text("min", style = MaterialTheme.typography.caption2, color = Muted)
            }
            StepButton("+") { step(1) }
        }
        Text(
            "recorded ${Time.formatDuration(recordedSeconds)}",
            style = MaterialTheme.typography.caption2,
            color = Muted,
        )
        Spacer(Modifier.height(12.dp))
        Row(
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = onDiscard,
                colors = ButtonDefaults.secondaryButtonColors(),
                modifier = Modifier.size(44.dp),
            ) { Text("✕", style = MaterialTheme.typography.title3, color = Muted) }

            Button(
                onClick = {
                    view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                    onConfirm(minutes * 60L)
                },
                colors = ButtonDefaults.primaryButtonColors(),
                modifier = Modifier.size(52.dp),
            ) { CheckGlyph(Ink) }
        }
    }
}

@Composable
private fun StepButton(label: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        colors = ButtonDefaults.secondaryButtonColors(),
        modifier = Modifier.size(38.dp),
    ) { Text(label, style = MaterialTheme.typography.title2, color = Cream) }
}

// --- control glyphs (drawn, so no icon dependency) --------------------------

@Composable
private fun PauseGlyph(color: Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(width = 5.dp, height = 16.dp).clip(RoundedCornerShape(2.dp)).background(color))
        Box(Modifier.size(width = 5.dp, height = 16.dp).clip(RoundedCornerShape(2.dp)).background(color))
    }
}

@Composable
private fun PlayGlyph(color: Color) {
    Canvas(Modifier.size(16.dp)) {
        val path = Path().apply {
            moveTo(size.width * 0.1f, 0f)
            lineTo(size.width * 0.95f, size.height / 2f)
            lineTo(size.width * 0.1f, size.height)
            close()
        }
        drawPath(path, color)
    }
}

@Composable
private fun StopGlyph(color: Color) {
    Box(Modifier.size(15.dp).clip(RoundedCornerShape(3.dp)).background(color))
}

@Composable
private fun CheckGlyph(color: Color) {
    Canvas(Modifier.size(20.dp)) {
        val path = Path().apply {
            moveTo(size.width * 0.2f, size.height * 0.55f)
            lineTo(size.width * 0.42f, size.height * 0.78f)
            lineTo(size.width * 0.82f, size.height * 0.28f)
        }
        drawPath(path, color, style = Stroke(width = size.width * 0.12f))
    }
}
