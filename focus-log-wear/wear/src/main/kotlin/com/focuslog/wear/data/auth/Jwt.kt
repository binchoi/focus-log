package com.focuslog.wear.data.auth

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec

/**
 * Service-account auth — a port of `auth/credentials.ts`. A service-account key
 * signs RS256 JWTs which are exchanged for short-lived access tokens against
 * Google's OAuth endpoint. The token is cached and refreshed a few minutes
 * before expiry so a long request cannot straddle the boundary.
 *
 * Note on the Keystore hardening the plan calls for: importing an *externally
 * generated* RSA key into the AndroidKeyStore as non-exportable requires wrapping
 * it in a self-signed certificate (KeyStore.PrivateKeyEntry needs a cert chain),
 * which in practice needs BouncyCastle. That step is a documented follow-up to be
 * verified on-device (see wear/README.md); [Rs256Signer] below signs with the
 * parsed key directly, which is functionally identical and keeps the key off any
 * server and out of logs.
 */

/** Supplies a bearer token to the Sheets client. */
interface AccessTokenProvider {
    suspend fun token(): String
    fun invalidate()
}

fun interface JwtSigner {
    /** RSA-SHA256 signature over [data]. */
    fun sign(data: ByteArray): ByteArray
}

object Pem {
    /** Parses a PKCS#8 PEM private key (the `private_key` field of the SA JSON). */
    fun toPrivateKey(pem: String): PrivateKey {
        val body = pem
            .replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "")
            .replace("\\n", "\n") // survive a key pasted with escaped newlines
            .replace(Regex("\\s"), "")
        val der = Base64.decode(body, Base64.DEFAULT)
        return KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(der))
    }
}

class Rs256Signer(private val privateKey: PrivateKey) : JwtSigner {
    override fun sign(data: ByteArray): ByteArray =
        Signature.getInstance("SHA256withRSA").run {
            initSign(privateKey)
            update(data)
            sign()
        }
}

/**
 * Mints and caches Google access tokens for the Sheets scope.
 */
class GoogleTokenProvider(
    private val clientEmail: String,
    private val signer: JwtSigner,
    private val http: OkHttpClient,
    private val now: () -> Long = { System.currentTimeMillis() },
) : AccessTokenProvider {

    private val mutex = Mutex()
    private var cachedToken: String? = null
    private var expiresAtMs: Long = 0

    override fun invalidate() {
        cachedToken = null
        expiresAtMs = 0
    }

    override suspend fun token(): String = mutex.withLock {
        val current = cachedToken
        if (current != null && now() < expiresAtMs) {
            current
        } else {
            exchange().also { cachedToken = it }
        }
    }

    private suspend fun exchange(): String = withContext(Dispatchers.IO) {
        val issuedAt = now() / 1000
        val expiry = issuedAt + TOKEN_LIFETIME_SECONDS

        val header = json("alg" to "RS256", "typ" to "JWT")
        val claim = JSONObject().apply {
            put("iss", clientEmail)
            put("scope", SCOPE)
            put("aud", TOKEN_URL)
            put("iat", issuedAt)
            put("exp", expiry)
        }.toString()

        val signingInput = "${base64Url(header)}.${base64Url(claim)}"
        val signature = base64Url(signer.sign(signingInput.toByteArray(Charsets.UTF_8)))
        val assertion = "$signingInput.$signature"

        val body = FormBody.Builder()
            .add("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
            .add("assertion", assertion)
            .build()
        val request = Request.Builder().url(TOKEN_URL).post(body).build()

        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                error("Token exchange failed (${response.code}): ${text.take(300)}")
            }
            val payload = JSONObject(text)
            val accessToken = payload.getString("access_token")
            val expiresIn = payload.optLong("expires_in", TOKEN_LIFETIME_SECONDS)
            // Refresh REFRESH_MARGIN early so a long request can't straddle expiry.
            expiresAtMs = now() + (expiresIn - REFRESH_MARGIN_SECONDS) * 1000
            accessToken
        }
    }

    private fun json(vararg pairs: Pair<String, String>): String =
        JSONObject().apply { pairs.forEach { (k, v) -> put(k, v) } }.toString()

    private fun base64Url(text: String): String = base64Url(text.toByteArray(Charsets.UTF_8))
    private fun base64Url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    companion object {
        private const val TOKEN_URL = "https://oauth2.googleapis.com/token"
        private const val SCOPE = "https://www.googleapis.com/auth/spreadsheets"
        private const val TOKEN_LIFETIME_SECONDS = 3600L
        private const val REFRESH_MARGIN_SECONDS = 300L
    }
}
