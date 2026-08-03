package com.focuslog.wear

import android.content.Context
import com.focuslog.core.store.Repo
import com.focuslog.core.sync.SyncEngine
import com.focuslog.wear.data.DeviceId
import com.focuslog.wear.data.auth.GoogleTokenProvider
import com.focuslog.wear.data.auth.Pem
import com.focuslog.wear.data.auth.Rs256Signer
import com.focuslog.wear.data.config.AppConfig
import com.focuslog.wear.data.room.FocusLogDatabase
import com.focuslog.wear.data.room.ReactiveQueries
import com.focuslog.wear.data.room.RoomLocalStore
import com.focuslog.wear.data.sheets.OkHttpSheetsClient
import com.focuslog.wear.timer.TimerController
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Manual dependency graph. Small enough that a DI framework would be overhead;
 * everything is a lazy singleton built from [AppConfig].
 *
 * [syncEngine] is null when the app is unconfigured (no `focus-config.json`), so
 * the timer and local store still work fully offline — sync simply does nothing
 * until a credential is present.
 */
class AppGraph private constructor(context: Context) {

    val appContext: Context = context.applicationContext

    val config: AppConfig? = AppConfig.load(appContext)

    val deviceId: String = DeviceId.get(appContext)

    private val db = FocusLogDatabase.get(appContext)
    val store = RoomLocalStore(db)
    val queries = ReactiveQueries(db)

    val repo = Repo(store = store, deviceId = { deviceId })

    val timer = TimerController(appContext, db)

    private val http: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(30, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .build()

    val syncEngine: SyncEngine? = config?.let { cfg ->
        val signer = Rs256Signer(Pem.toPrivateKey(cfg.privateKeyPem))
        val tokens = GoogleTokenProvider(cfg.clientEmail, signer, http)
        val client = OkHttpSheetsClient(cfg.spreadsheetId, tokens, http)
        SyncEngine(client, store)
    }

    val isConfigured: Boolean get() = syncEngine != null

    companion object {
        @Volatile
        private var instance: AppGraph? = null

        fun get(context: Context): AppGraph =
            instance ?: synchronized(this) {
                instance ?: AppGraph(context).also { instance = it }
            }
    }
}
