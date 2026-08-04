package com.focuslog.core

/**
 * A minimal JSON reader, just enough to load the shared /conformance vectors.
 *
 * :core deliberately has no runtime dependencies and its tests run fully offline,
 * so rather than pull in a JSON library we parse the (small, trusted) vector
 * files by hand. Objects -> LinkedHashMap, arrays -> List, numbers -> Double,
 * plus String/Boolean/null.
 */
object MiniJson {
    fun parse(text: String): Any? = Parser(text).parseValue()

    private class Parser(private val s: String) {
        private var i = 0

        fun parseValue(): Any? {
            skipWs()
            return when (val c = s[i]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> parseString()
                't', 'f' -> parseBool()
                'n' -> parseNull()
                else -> if (c == '-' || c.isDigit()) parseNumber() else error("Unexpected '$c' at $i")
            }
        }

        private fun parseObject(): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>()
            i++ // {
            skipWs()
            if (s[i] == '}') { i++; return m }
            while (true) {
                skipWs()
                val key = parseString()
                skipWs(); expect(':')
                m[key] = parseValue()
                skipWs()
                when (s[i]) {
                    ',' -> i++
                    '}' -> { i++; return m }
                    else -> error("Expected ',' or '}' at $i")
                }
            }
        }

        private fun parseArray(): List<Any?> {
            val a = ArrayList<Any?>()
            i++ // [
            skipWs()
            if (s[i] == ']') { i++; return a }
            while (true) {
                a.add(parseValue())
                skipWs()
                when (s[i]) {
                    ',' -> i++
                    ']' -> { i++; return a }
                    else -> error("Expected ',' or ']' at $i")
                }
            }
        }

        private fun parseString(): String {
            expect('"')
            val sb = StringBuilder()
            while (true) {
                when (val c = s[i++]) {
                    '"' -> return sb.toString()
                    '\\' -> when (val e = s[i++]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'n' -> sb.append('\n')
                        't' -> sb.append('\t')
                        'r' -> sb.append('\r')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'u' -> { sb.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                        else -> error("Bad escape \\$e")
                    }
                    else -> sb.append(c)
                }
            }
        }

        private fun parseNumber(): Double {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && (s[i].isDigit() || s[i] in ".eE+-")) i++
            return s.substring(start, i).toDouble()
        }

        private fun parseBool(): Boolean =
            if (s.startsWith("true", i)) { i += 4; true } else { i += 5; false }

        private fun parseNull(): Any? { i += 4; return null }

        private fun skipWs() { while (i < s.length && s[i].isWhitespace()) i++ }

        private fun expect(c: Char) {
            if (s[i] != c) error("Expected '$c' at $i, got '${s[i]}'")
            i++
        }
    }
}
