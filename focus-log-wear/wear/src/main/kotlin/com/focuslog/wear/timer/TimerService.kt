package com.focuslog.wear.timer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import com.focuslog.core.time.Time
import com.focuslog.core.timer.TimerPhase
import com.focuslog.wear.FocusLogApp
import com.focuslog.wear.R
import com.focuslog.wear.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Foreground service that keeps a running session alive under doze and shows it
 * as an Ongoing Activity. The service does not *count* time — elapsed is always
 * derived from the persisted segment timestamps — it only keeps the process
 * resident and the display current. If the system kills it anyway, the session
 * is recovered from Room on next launch with the correct elapsed time.
 */
class TimerService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onBind(intent: Intent): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel()
        startForegroundCompat(buildNotification("0:00"))

        val timer = (application as FocusLogApp).graph.timer
        scope.launch {
            while (true) {
                val state = timer.state.value
                if (state == null) {
                    stopSelfSafely()
                    break
                }
                notificationManager().notify(NOTIFICATION_ID, buildNotification(Time.formatDuration(timer.elapsedSeconds())))
                delay(1000)
            }
        }
        // Restart if killed: the persisted session in Room is the source of truth.
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, 0)
        }
    }

    private fun stopSelfSafely() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun buildNotification(elapsed: String): Notification {
        val timer = (application as FocusLogApp).graph.timer
        val paused = timer.phase() == TimerPhase.PAUSED
        val title = if (paused) "Paused" else "Focusing"

        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(elapsed)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setContentIntent(open)

        // Surface it on the watch face as an Ongoing Activity.
        OngoingActivity.Builder(this, NOTIFICATION_ID, builder)
            .setStaticIcon(R.drawable.ic_launcher_foreground)
            .setTouchIntent(open)
            .setStatus(Status.Builder().addTemplate(elapsed).build())
            .build()
            .apply(this)

        return builder.build()
    }

    private fun ensureChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID, "Focus session", NotificationManager.IMPORTANCE_LOW,
        ).apply { setShowBadge(false) }
        notificationManager().createNotificationChannel(channel)
    }

    private fun notificationManager() =
        getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    companion object {
        private const val CHANNEL_ID = "focus-session"
        private const val NOTIFICATION_ID = 42

        fun ensureRunning(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, TimerService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, TimerService::class.java))
        }
    }
}
