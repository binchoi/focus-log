// Root build. Every plugin used by any module is declared here once with a
// version (apply false) so the classpath has a single known version; modules
// then apply them without re-declaring a version. Declaring them per-module
// instead triggers Gradle's "plugin already on the classpath with an unknown
// version" error once more than one module loads (e.g. :core's Kotlin plugin
// vs :wear's).
plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.ksp) apply false
}
