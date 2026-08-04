package com.focuslog.core

import com.focuslog.core.model.Versioned
import com.focuslog.core.sheets.decodeSegments
import com.focuslog.core.sheets.encodeSegments
import com.focuslog.core.sync.compareVersions
import com.focuslog.core.sync.pickWinner
import com.focuslog.core.timer.Segment
import com.focuslog.core.timer.TimerEngine
import com.focuslog.core.timer.TimerState
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File

/**
 * Cross-core conformance: the Wear OS core must agree with the web (TypeScript)
 * core on every rule the server-free last-write-wins protocol depends on. Both
 * suites load the *same* vectors in /conformance; the TS twin is
 * focus-log/src/lib/conformance.test.ts.
 *
 * If this drifts from the web core, two devices can disagree on which edit won or
 * how long a session was. Keep the vectors the shared source of truth and change
 * both cores together. The /conformance path is passed in by Gradle as the
 * `conformanceDir` system property (see core/build.gradle.kts).
 */
class ConformanceTest {
    private val dir = File(
        System.getProperty("conformanceDir") ?: error("conformanceDir system property not set"),
    )

    private fun load(file: String): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return MiniJson.parse(File(dir, file).readText()) as Map<String, Any?>
    }

    private fun segmentsOf(pairs: Any?): List<Segment> {
        @Suppress("UNCHECKED_CAST")
        return (pairs as List<Any?>).map {
            @Suppress("UNCHECKED_CAST")
            val pair = it as List<Any?>
            Segment((pair[0] as Double).toLong(), (pair[1] as Double?)?.toLong())
        }
    }

    @TestFactory
    fun elapsed(): List<DynamicTest> {
        @Suppress("UNCHECKED_CAST")
        val cases = load("elapsed.json")["cases"] as List<Map<String, Any?>>
        return cases.map { c ->
            DynamicTest.dynamicTest(c["name"] as String) {
                val state = TimerState("g", segmentsOf(c["segments"]), startedAt = 0L, note = "")
                val now = (c["now"] as Double).toLong()
                assertEquals((c["expectedSeconds"] as Double).toLong(), TimerEngine.elapsedSeconds(state, now))
            }
        }
    }

    private data class Rec(
        val id: String,
        override val updatedAt: String,
        override val deviceId: String,
        override val deleted: Boolean = false,
    ) : Versioned

    private fun recOf(m: Map<String, Any?>): Rec =
        Rec(m["id"] as String, m["updated_at"] as String, m["device_id"] as String)

    @TestFactory
    fun lastWriteWins(): List<DynamicTest> {
        @Suppress("UNCHECKED_CAST")
        val cases = load("lww.json")["cases"] as List<Map<String, Any?>>
        return cases.map { c ->
            DynamicTest.dynamicTest(c["name"] as String) {
                @Suppress("UNCHECKED_CAST")
                val a = recOf(c["a"] as Map<String, Any?>)
                @Suppress("UNCHECKED_CAST")
                val b = recOf(c["b"] as Map<String, Any?>)
                val winner = c["winner"] as String
                val expectedId = if (winner == "a") "A" else "B"
                assertEquals(expectedId, pickWinner(a, b).id)

                if (compareVersions(a, b) != 0) {
                    // A real winner is order-independent.
                    assertEquals(expectedId, pickWinner(b, a).id)
                } else {
                    // An exact tie is expressed as "a"; pickWinner returns its first arg.
                    assertEquals("a", winner)
                    assertEquals("B", pickWinner(b, a).id)
                }
            }
        }
    }

    @TestFactory
    fun segmentsCodec(): List<DynamicTest> {
        val data = load("segments-codec.json")
        @Suppress("UNCHECKED_CAST")
        val cases = data["cases"] as List<Map<String, Any?>>
        @Suppress("UNCHECKED_CAST")
        val invalid = data["invalidEncoded"] as List<String>

        val roundTrips = cases.map { c ->
            DynamicTest.dynamicTest(c["name"] as String) {
                val segments = segmentsOf(c["segments"])
                val encoded = c["encoded"] as String
                assertEquals(encoded, encodeSegments(segments))
                assertEquals(segments, decodeSegments(encoded))
            }
        }
        val rejections = invalid.map { bad ->
            DynamicTest.dynamicTest("rejects \"$bad\"") {
                assertThrows(Exception::class.java) { decodeSegments(bad) }
            }
        }
        return roundTrips + rejections
    }
}
