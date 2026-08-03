package com.focuslog.wear.data.room

import com.focuslog.core.model.Goal
import com.focuslog.core.model.Session
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Read-only Flows for the UI. A background sync writing pulled rows into Room
 * pushes straight through these into Compose, with no refetch wiring — the same
 * live-query property the web app gets from Dexie.
 */
class ReactiveQueries(private val db: FocusLogDatabase) {

    fun visibleGoals(): Flow<List<Goal>> =
        db.goals().observeVisible().map { rows -> rows.map { it.toModel() } }

    fun sessionsOnDate(date: String): Flow<List<Session>> =
        db.sessions().observeOnDate(date).map { rows -> rows.map { it.toModel() } }

    fun pendingCount(): Flow<Int> = db.outbox().observeCount()
}
