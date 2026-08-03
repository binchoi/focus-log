package com.focuslog.wear.data.room

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface GoalDao {
    @Query("SELECT * FROM goals WHERE goalId = :goalId")
    suspend fun get(goalId: String): GoalEntity?

    @Query("SELECT * FROM goals")
    suspend fun all(): List<GoalEntity>

    @Query("SELECT * FROM goals WHERE deleted = 0 ORDER BY sortOrder, title")
    fun observeVisible(): Flow<List<GoalEntity>>

    @Upsert
    suspend fun upsert(goals: List<GoalEntity>)
}

@Dao
interface SessionDao {
    @Query("SELECT * FROM sessions WHERE logId = :logId")
    suspend fun get(logId: String): SessionEntity?

    @Query("SELECT * FROM sessions")
    suspend fun all(): List<SessionEntity>

    @Query("SELECT * FROM sessions WHERE deleted = 0 AND localDate = :date")
    fun observeOnDate(date: String): Flow<List<SessionEntity>>

    @Query("SELECT * FROM sessions WHERE deleted = 0 AND localDate = :date")
    suspend fun onDate(date: String): List<SessionEntity>

    @Upsert
    suspend fun upsert(sessions: List<SessionEntity>)
}

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox ORDER BY opId")
    suspend fun all(): List<OutboxEntity>

    @Query("SELECT * FROM outbox WHERE entityId = :entityId")
    suspend fun forEntity(entityId: String): List<OutboxEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(op: OutboxEntity): Long

    @Upsert
    suspend fun upsert(ops: List<OutboxEntity>)

    @Query("DELETE FROM outbox WHERE opId IN (:opIds)")
    suspend fun delete(opIds: List<Long>)

    @Query("SELECT COUNT(*) FROM outbox")
    suspend fun count(): Int

    @Query("SELECT COUNT(*) FROM outbox")
    fun observeCount(): Flow<Int>
}

@Dao
interface ActiveSessionDao {
    @Query("SELECT * FROM active_session WHERE id = 'current'")
    suspend fun get(): ActiveSessionEntity?

    @Query("SELECT * FROM active_session WHERE id = 'current'")
    fun observe(): Flow<ActiveSessionEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(active: ActiveSessionEntity)

    @Query("DELETE FROM active_session")
    suspend fun clear()
}

@Dao
interface SyncMetaDao {
    @Query("SELECT value FROM sync_meta WHERE key = :key")
    suspend fun get(key: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: SyncMetaEntity)
}
