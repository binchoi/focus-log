package com.focuslog.wear.data.room

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * v1 → v2 adds the cross-device timer columns to `active_session`. A real
 * migration (not destructive) so an in-progress timer and any un-synced local
 * goals/sessions survive the upgrade.
 */
private val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE active_session ADD COLUMN logId TEXT")
        db.execSQL("ALTER TABLE active_session ADD COLUMN deviceId TEXT NOT NULL DEFAULT ''")
        db.execSQL("ALTER TABLE active_session ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0")
    }
}

@Database(
    entities = [
        GoalEntity::class,
        SessionEntity::class,
        OutboxEntity::class,
        ActiveSessionEntity::class,
        SyncMetaEntity::class,
    ],
    version = 2,
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
                ).addMigrations(MIGRATION_1_2).build().also { instance = it }
            }
    }
}
