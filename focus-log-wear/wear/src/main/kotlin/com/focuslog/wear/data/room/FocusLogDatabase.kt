package com.focuslog.wear.data.room

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        GoalEntity::class,
        SessionEntity::class,
        OutboxEntity::class,
        ActiveSessionEntity::class,
        SyncMetaEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class FocusLogDatabase : RoomDatabase() {
    abstract fun goals(): GoalDao
    abstract fun sessions(): SessionDao
    abstract fun outbox(): OutboxDao
    abstract fun activeSession(): ActiveSessionDao
    abstract fun syncMeta(): SyncMetaDao

    companion object {
        @Volatile
        private var instance: FocusLogDatabase? = null

        fun get(context: Context): FocusLogDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    FocusLogDatabase::class.java,
                    "focus-log",
                ).build().also { instance = it }
            }
    }
}
