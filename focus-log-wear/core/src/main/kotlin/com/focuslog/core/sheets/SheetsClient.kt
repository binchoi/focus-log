package com.focuslog.core.sheets

import kotlin.math.min

/**
 * Google Sheets client contract and its error/backoff policy — the transport-
 * agnostic half of `sheets/client.ts`. The concrete HTTP implementation
 * (OkHttp) lives in the `:wear` module; everything here is pure and tested.
 *
 * Reads always use UNFORMATTED_VALUE and writes always use RAW — that pairing is
 * load-bearing: UNFORMATTED_VALUE stops 1234 arriving as "1,234", and RAW stops
 * Sheets re-parsing ISO timestamps into date serials or turning id "0012" into 12.
 */

private val SPREADSHEET_ID = Regex("^[A-Za-z0-9_-]{20,64}$")

fun isValidSpreadsheetId(id: String?): Boolean = id != null && SPREADSHEET_ID.matches(id)

/** Pulls the id out of a pasted spreadsheet URL, or passes a bare id through. */
fun extractSpreadsheetId(input: String): String {
    val trimmed = input.trim()
    return Regex("/spreadsheets/d/([A-Za-z0-9_-]+)").find(trimmed)?.groupValues?.get(1) ?: trimmed
}

enum class SheetsErrorKind { AUTH, PERMISSION, NOT_FOUND, RATE_LIMIT, SERVER, NETWORK, BAD_REQUEST }

class SheetsError(
    message: String,
    val status: Int,
    val kind: SheetsErrorKind,
    val retryable: Boolean,
) : Exception(message)

/**
 * Map an HTTP status to a typed error. The distinction that matters on a watch,
 * where you can't read a stack trace: "offline / rate-limited / 5xx" is
 * retryable and deferred, while "not shared with the service account" (403) or
 * "wrong spreadsheet id" (404) is terminal and must be surfaced to the user.
 */
fun classify(status: Int, body: String = ""): SheetsError {
    val detail = body.take(400)
    return when {
        status == 401 -> SheetsError("Credentials rejected by Google. $detail", status, SheetsErrorKind.AUTH, true)
        status == 403 -> SheetsError(
            "Access denied. Is the spreadsheet shared with the service account as an Editor? $detail",
            status, SheetsErrorKind.PERMISSION, false,
        )
        status == 404 -> SheetsError(
            "Spreadsheet or tab not found. Check the spreadsheet ID and tab names. $detail",
            status, SheetsErrorKind.NOT_FOUND, false,
        )
        status == 429 -> SheetsError("Rate limited by Google. $detail", status, SheetsErrorKind.RATE_LIMIT, true)
        status >= 500 -> SheetsError("Google Sheets is unavailable. $detail", status, SheetsErrorKind.SERVER, true)
        else -> SheetsError("Sheets request failed ($status). $detail", status, SheetsErrorKind.BAD_REQUEST, false)
    }
}

/** A transport failure (offline, DNS, timeout) — always worth retrying. */
fun networkError(cause: String): SheetsError =
    SheetsError("Network request to Google Sheets failed: $cause", 0, SheetsErrorKind.NETWORK, true)

data class RetryPolicy(
    val maxAttempts: Int = 5,
    val baseDelayMs: Long = 500,
    val maxDelayMs: Long = 5 * 60 * 1000,
)

/**
 * Backoff for attempt N (1-based). Google's Retry-After is authoritative when
 * present; otherwise full jitter spreads retries so multiple queued writes don't
 * sync up. `jitter` is injected in [0,1) so tests are deterministic.
 */
fun backoffDelay(
    attempt: Int,
    policy: RetryPolicy = RetryPolicy(),
    retryAfterSeconds: Double? = null,
    jitter: Double = 0.5,
): Long {
    if (retryAfterSeconds != null && retryAfterSeconds.isFinite()) {
        return min((retryAfterSeconds * 1000).toLong(), policy.maxDelayMs)
    }
    val exponential = policy.baseDelayMs.toDouble() * Math.pow(2.0, (attempt - 1).toDouble())
    return min(Math.round(exponential * (0.5 + 0.5 * jitter)), policy.maxDelayMs)
}

/** What a full read of the three tabs returns, as raw rows. */
data class SheetRead(val goals: List<Row>, val sessions: List<Row>, val meta: List<Row>)

/**
 * The narrow surface the sync engine needs. Kept as an interface so [com.focuslog.core.sync.SyncEngine]
 * is testable without any network or credentials.
 */
interface SheetsClient {
    /** Reads all three tabs in one batched round-trip (UNFORMATTED_VALUE). */
    suspend fun readAll(): SheetRead

    /** Appends rows to a tab (RAW). Every mutation in focus-log is an append. */
    suspend fun append(range: String, rows: List<List<Cell>>)
}
