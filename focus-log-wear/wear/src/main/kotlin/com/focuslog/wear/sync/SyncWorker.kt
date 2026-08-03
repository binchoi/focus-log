package com.focuslog.wear.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.focuslog.core.sheets.SheetsError
import com.focuslog.wear.AppGraph

/**
 * Drains the outbox and pulls remote changes. The sync engine already treats
 * being offline as ordinary (it defers rather than throws), so:
 *   - a deferred / successful run -> success
 *   - a retryable failure that surfaced -> retry (WorkManager backs off)
 *   - a terminal failure (403/404) -> failure, so it stops hammering a
 *     misconfiguration the user must fix
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val engine = AppGraph.get(applicationContext).syncEngine ?: return Result.success()
        return try {
            engine.sync()
            Result.success()
        } catch (error: SheetsError) {
            if (error.retryable) Result.retry() else Result.failure()
        } catch (_: Exception) {
            Result.retry()
        }
    }
}
