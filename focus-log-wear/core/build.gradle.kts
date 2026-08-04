plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(kotlin("test-junit5"))
}

tasks.test {
    useJUnitPlatform()
    // The cross-core conformance vectors live at the repo root, one level above
    // this Gradle build (focus-log-wear/). Pass their location to the test so it
    // does not depend on the working directory.
    systemProperty("conformanceDir", rootProject.projectDir.parentFile.resolve("conformance").absolutePath)
}
