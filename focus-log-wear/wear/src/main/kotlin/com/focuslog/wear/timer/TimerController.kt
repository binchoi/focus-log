package com.focuslog.wear.timer

import android.content.Context
import com.focuslog.core.timer.Segment
import com.focuslog.core.timer.StopResult
import com.focuslog.core.timer.TimerEngine
import com.focuslog.core.timer.TimerPhase
import com.focuslog.core.timer.TimerState
import com.focuslog.wear.data.room.ActiveSessionEntity
import com.focuslog.wear.data.room.FocusLogDatabase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * Owns the single running session. The state is persisted to Room on every
 * change, so a doze-killed process restores the exact elapsed time on relaunch —
 * elapsed is always derived from the persisted segment timestamps (see the core
 * [TimerEngine]), never from a tick counter.
 *
 * The foreground [TimerService] is kept alive whenever a session exists (running
 * or paused) and torn down when it is logged or discarded.
 */
class TimerController(
    context: Context,
    db: FocusLogDatabase,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val appContext = context.applicationContext
    private val dao = db.activeSession()

    private val _state = MutableStateFlow<TimerState?>(null)
    val state: StateFlow<TimerState?> = _state.asStateFlow()

    /** Loads any persisted session (e.g. after a cold start). */
    suspend fun load(): TimerState? {
        val restored = dao.get()?.toState()
        _state.value = restored
        if (restored != null) TimerService.ensureRunning(appContext)
        return restored
    }

    fun elapsedSeconds(nowMs: Long = now()): Long = TimerEngine.elapsedSeconds(_state.value, nowMs)

    fun phase(): TimerPhase = TimerEngine.phaseOf(_state.value)

    /**
     * Starts (or keeps) a session for [goalId].
     *
     * If this goal is already being timed — running or paused — it is left
     * untouched so re-entering the screen never resets the clock. Otherwise a
     * fresh session begins, replacing any stale or other-goal session. That means
     * tapping a goal always lands on a live timer, never a stuck "Paused 0:00".
     */
    suspend fun start(goalId: String) {
        val current = _state.value
        if (current != null && current.goalId == goalId && TimerEngine.phaseOf(current) != TimerPhase.IDLE) {
            return
        }
        persist(TimerEngine.start(goalId, now()))
    }

    suspend fun pause() = _state.value?.let { persist(TimerEngine.pause(it, now())) }
    suspend fun resume() = _state.value?.let { persist(TimerEngine.resume(it, now())) }

    /** Closes the timer and returns what to log. Does not clear it — the caller
     *  commits or discards, so a crash mid-dialog cannot lose the session. */
    suspend fun stop(): StopResult? {
        val state = _state.value ?: return null
        val result = TimerEngine.stop(state, now())
        persist(TimerEngine.pause(state, now()))
        return result
    }

    suspend fun setNote(note: String) = _state.value?.let { persist(it.copy(note = note)) }

    suspend fun discard() {
        dao.clear()
        _state.value = null
        TimerService.stop(appContext)
    }

    private suspend fun persist(state: TimerState) {
        dao.put(state.toEntity())
        _state.value = state
        TimerService.ensureRunning(appContext)
    }

    // --- segment (de)serialisation -----------------------------------------

    private fun TimerState.toEntity() = ActiveSessionEntity(
        goalId = goalId,
        segmentsJson = JSONArray().apply {
            segments.forEach { seg ->
                put(JSONObject().apply {
                    put("start", seg.start)
                    if (seg.end != null) put("end", seg.end) else put("end", JSONObject.NULL)
                })
            }
        }.toString(),
        startedAt = startedAt,
        note = note,
    )

    private fun ActiveSessionEntity.toState(): TimerState {
        val array = JSONArray(segmentsJson)
        val segments = (0 until array.length()).map { i ->
            val o = array.getJSONObject(i)
            Segment(
                start = o.getLong("start"),
                end = if (o.isNull("end")) null else o.getLong("end"),
            )
        }
        return TimerState(goalId = goalId, segments = segments, startedAt = startedAt, note = note)
    }
}
