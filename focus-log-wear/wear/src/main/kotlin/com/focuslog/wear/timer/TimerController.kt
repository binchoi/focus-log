package com.focuslog.wear.timer

import android.content.Context
import com.focuslog.core.model.ActiveTimer
import com.focuslog.core.store.Repo
import com.focuslog.core.time.Time
import com.focuslog.core.timer.ActiveContext
import com.focuslog.core.timer.Reconciliation
import com.focuslog.core.timer.Segment
import com.focuslog.core.timer.StopResult
import com.focuslog.core.timer.TimerEngine
import com.focuslog.core.timer.TimerPhase
import com.focuslog.core.timer.TimerState
import com.focuslog.core.timer.closedActive
import com.focuslog.core.timer.runningActive
import com.focuslog.wear.data.room.ActiveSessionEntity
import com.focuslog.wear.data.room.FocusLogDatabase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/**
 * Owns the single running session and, on a v2 sheet, keeps it in step with the
 * shared `active` tab so a timer started on the phone/desktop can be seen and
 * ended here (and vice versa). The state is persisted to Room on every change, so
 * a doze-killed process restores exact elapsed time on relaunch — elapsed is
 * always derived from the persisted segment timestamps (core [TimerEngine]).
 *
 * Local changes publish the timer to the sheet (via [Repo.enqueueActive]) and
 * request a sync; a pull reconciles remote changes back in via [readActiveForSync]
 * / [applyReconciled] (called by the sync engine's ActiveBridge). Mirrors the web
 * app's TimerStore + activeBridge.
 */
class TimerController(
    context: Context,
    db: FocusLogDatabase,
    private val repo: Repo,
    private val deviceId: () -> String,
    private val ids: () -> String = { UUID.randomUUID().toString() },
    private val requestSync: () -> Unit = {},
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val appContext = context.applicationContext
    private val dao = db.activeSession()

    private val _state = MutableStateFlow<TimerState?>(null)
    val state: StateFlow<TimerState?> = _state.asStateFlow()

    /** Snapshot captured by [readActiveForSync] for optimistic concurrency in [applyReconciled]. */
    private var seenUpdatedAt: Long? = null
    private var seenLocal: ActiveTimer? = null

    suspend fun load(): TimerState? {
        val restored = dao.get()?.toState()
        _state.value = restored
        if (restored != null) TimerService.ensureRunning(appContext)
        return restored
    }

    fun elapsedSeconds(nowMs: Long = now()): Long = TimerEngine.elapsedSeconds(_state.value, nowMs)

    fun phase(): TimerPhase = TimerEngine.phaseOf(_state.value)

    suspend fun start(goalId: String) {
        val current = _state.value
        if (current != null && current.goalId == goalId && TimerEngine.phaseOf(current) != TimerPhase.IDLE) {
            return
        }
        // Mint the shared id at start; the finalised session reuses it, so ending
        // this timer from another device collapses to one row.
        persist(TimerEngine.start(goalId, now(), note = "", logId = ids()))
    }

    suspend fun pause() = _state.value?.let { persist(TimerEngine.pause(it, now())) }
    suspend fun resume() = _state.value?.let { persist(TimerEngine.resume(it, now())) }

    suspend fun stop(): StopResult? {
        val state = _state.value ?: return null
        val result = TimerEngine.stop(state, now())
        persist(TimerEngine.pause(state, now()))
        return result
    }

    suspend fun setNote(note: String) = _state.value?.let { persist(it.copy(note = note)) }

    /** Stops and discards — publishes a tombstone so other devices learn it ended. */
    suspend fun discard() {
        val row = dao.get()
        val logId = row?.logId
        if (row != null && logId != null) {
            repo.enqueueActive(closedActive(row.toState(), ActiveContext(logId, deviceId(), now())))
            requestSync()
        }
        dao.clear()
        _state.value = null
        TimerService.stop(appContext)
    }

    private suspend fun persist(state: TimerState) {
        val at = now()
        dao.put(state.toEntity(deviceId = deviceId(), updatedAt = at))
        _state.value = state
        // Publish the running/paused timer so other devices can see and control it.
        if (state.logId != null) {
            repo.enqueueActive(runningActive(state, ActiveContext(state.logId, deviceId(), at)))
            requestSync()
        }
        TimerService.ensureRunning(appContext)
    }

    // --- ActiveBridge: reconcile the sheet's active tab into the local timer ---

    /** This device's current timer as an `active` record, or null when idle / no shared id. */
    suspend fun readActiveForSync(): ActiveTimer? {
        val row = dao.get()
        seenUpdatedAt = row?.updatedAt
        seenLocal = row?.takeIf { it.logId != null }?.toActiveTimer()
        return seenLocal
    }

    /**
     * Apply a reconciliation under optimistic concurrency: if the local timer
     * changed since [readActiveForSync] (the user paused/stopped mid-pull), skip —
     * reconcile is idempotent and the next pull retries.
     */
    suspend fun applyReconciled(result: Reconciliation) {
        if (dao.get()?.updatedAt != seenUpdatedAt) return

        val loser = seenLocal
        if (result.closeLogId != null && loser != null && loser.logId == result.closeLogId) {
            // Auto-close our losing concurrent start — a tombstone, no session logged.
            repo.enqueueActive(loser.copy(deleted = true, updatedAt = Time.toIsoUtc(now())))
            requestSync()
        }
        setLocal(result.local)
    }

    /** Adopt a reconciled shared timer without re-publishing (mirroring, not authoring). */
    private suspend fun setLocal(active: ActiveTimer?) {
        if (active == null) {
            dao.clear()
            _state.value = null
            TimerService.stop(appContext)
        } else {
            dao.put(active.toEntity())
            _state.value = active.toState()
            TimerService.ensureRunning(appContext)
        }
    }

    // --- segment (de)serialisation & entity mapping ------------------------

    private fun segmentsToJson(segments: List<Segment>): String = JSONArray().apply {
        segments.forEach { seg ->
            put(JSONObject().apply {
                put("start", seg.start)
                if (seg.end != null) put("end", seg.end) else put("end", JSONObject.NULL)
            })
        }
    }.toString()

    private fun jsonToSegments(json: String): List<Segment> {
        val array = JSONArray(json)
        return (0 until array.length()).map { i ->
            val o = array.getJSONObject(i)
            Segment(start = o.getLong("start"), end = if (o.isNull("end")) null else o.getLong("end"))
        }
    }

    private fun TimerState.toEntity(deviceId: String, updatedAt: Long) = ActiveSessionEntity(
        goalId = goalId,
        segmentsJson = segmentsToJson(segments),
        startedAt = startedAt,
        note = note,
        logId = logId,
        deviceId = deviceId,
        updatedAt = updatedAt,
    )

    private fun ActiveSessionEntity.toState() = TimerState(
        goalId = goalId,
        segments = jsonToSegments(segmentsJson),
        startedAt = startedAt,
        note = note,
        logId = logId,
    )

    /** Only called when [ActiveSessionEntity.logId] is non-null. */
    private fun ActiveSessionEntity.toActiveTimer() = ActiveTimer(
        logId = logId!!,
        goalId = goalId,
        segments = jsonToSegments(segmentsJson),
        note = note,
        updatedAt = Time.toIsoUtc(updatedAt),
        deleted = false,
        deviceId = deviceId,
    )

    private fun ActiveTimer.toEntity() = ActiveSessionEntity(
        goalId = goalId,
        segmentsJson = segmentsToJson(segments),
        startedAt = segments.firstOrNull()?.start ?: 0L,
        note = note,
        logId = logId,
        deviceId = deviceId,
        updatedAt = Instant.parse(updatedAt).toEpochMilli(),
    )

    private fun ActiveTimer.toState() = TimerState(
        goalId = goalId,
        segments = segments,
        startedAt = segments.firstOrNull()?.start ?: 0L,
        note = note,
        logId = logId,
    )
}
