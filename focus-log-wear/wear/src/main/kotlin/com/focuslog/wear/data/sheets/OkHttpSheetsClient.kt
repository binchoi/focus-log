package com.focuslog.wear.data.sheets

import com.focuslog.core.sheets.Cell
import com.focuslog.core.sheets.Ranges
import com.focuslog.core.sheets.Row
import com.focuslog.core.sheets.RetryPolicy
import com.focuslog.core.sheets.SheetRead
import com.focuslog.core.sheets.SheetsClient
import com.focuslog.core.sheets.SheetsError
import com.focuslog.core.sheets.SheetsErrorKind
import com.focuslog.core.sheets.backoffDelay
import com.focuslog.core.sheets.classify
import com.focuslog.core.sheets.networkError
import com.focuslog.wear.data.auth.AccessTokenProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import kotlin.random.Random

/**
 * Google Sheets v4 client over OkHttp — the Android implementation of the core
 * [SheetsClient] contract. Reads use UNFORMATTED_VALUE, writes use RAW; the retry
 * loop mirrors `sheets/client.ts`: retryable failures (offline, 429, 5xx) back
 * off and retry, terminal ones (403/404) throw for the caller to surface.
 */
class OkHttpSheetsClient(
    private val spreadsheetId: String,
    private val tokens: AccessTokenProvider,
    private val http: OkHttpClient,
    private val policy: RetryPolicy = RetryPolicy(),
) : SheetsClient {

    override suspend fun readAll(): SheetRead {
        val url = spreadsheetUrl()
            .addPathSegment("values:batchGet")
            .addQueryParameter("ranges", Ranges.goals)
            .addQueryParameter("ranges", Ranges.sessions)
            .addQueryParameter("ranges", Ranges.meta)
            .addQueryParameter("valueRenderOption", "UNFORMATTED_VALUE")
            .addQueryParameter("dateTimeRenderOption", "FORMATTED_STRING")
            .build()

        val payload = request(Request.Builder().url(url).get())
        val ranges = payload.optJSONArray("valueRanges") ?: JSONArray()
        // Google echoes ranges in request order.
        return SheetRead(
            goals = rowsAt(ranges, 0),
            sessions = rowsAt(ranges, 1),
            meta = rowsAt(ranges, 2),
        )
    }

    override suspend fun append(range: String, rows: List<List<Cell>>) {
        if (rows.isEmpty()) return
        // The range ("sessions!A:L") and the ":append" custom-method suffix are one
        // path segment; addPathSegment encodes it correctly.
        val url = spreadsheetUrl()
            .addPathSegment("values")
            .addPathSegment("$range:append")
            .addQueryParameter("valueInputOption", "RAW")
            .addQueryParameter("insertDataOption", "INSERT_ROWS")
            .build()
        val body = JSONObject().apply {
            put("range", range)
            put("majorDimension", "ROWS")
            put("values", toJsonRows(rows))
        }.toString().toRequestBody(JSON)
        request(Request.Builder().url(url).post(body))
    }

    // --- request loop -------------------------------------------------------

    private suspend fun request(builder: Request.Builder): JSONObject = withContext(Dispatchers.IO) {
        var lastError: SheetsError? = null

        for (attempt in 1..policy.maxAttempts) {
            val response = try {
                val token = tokens.token()
                val request = builder
                    .header("Authorization", "Bearer $token")
                    .header("Content-Type", "application/json")
                    .build()
                http.newCall(request).execute()
            } catch (cause: IOException) {
                lastError = networkError(cause.message ?: "unknown")
                if (attempt == policy.maxAttempts) break
                delay(backoffDelay(attempt, policy, jitter = Random.nextDouble()))
                continue
            }

            response.use { r ->
                val text = r.body?.string().orEmpty()
                if (r.isSuccessful) {
                    return@withContext if (text.isBlank()) JSONObject() else JSONObject(text)
                }
                val error = classify(r.code, text)
                lastError = error
                if (error.kind == SheetsErrorKind.AUTH) tokens.invalidate()
                if (!error.retryable || attempt == policy.maxAttempts) {
                    throw error
                }
                val retryAfter = r.header("Retry-After")?.toDoubleOrNull()
                delay(backoffDelay(attempt, policy, retryAfter, Random.nextDouble()))
            }
        }
        throw lastError ?: SheetsError("Sheets request failed", 0, SheetsErrorKind.NETWORK, true)
    }

    private fun spreadsheetUrl() =
        SHEETS_BASE.toHttpUrl().newBuilder().addPathSegment(spreadsheetId)

    private fun rowsAt(ranges: JSONArray, index: Int): List<Row> {
        if (index >= ranges.length()) return emptyList()
        val values = ranges.getJSONObject(index).optJSONArray("values") ?: return emptyList()
        return (0 until values.length()).map { r ->
            val row = values.getJSONArray(r)
            (0 until row.length()).map { c -> row.get(c).toCell() }
        }
    }

    private fun Any?.toCell(): Cell = when (this) {
        JSONObject.NULL -> null
        is Int -> this
        is Long -> this
        is Double -> this
        is Boolean -> this
        else -> toString()
    }

    private fun toJsonRows(rows: List<List<Cell>>): JSONArray = JSONArray().apply {
        for (row in rows) {
            put(JSONArray().apply { row.forEach { put(it ?: "") } })
        }
    }

    companion object {
        private const val SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets"
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
