pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "focus-log-wear"

// Pure-JVM Kotlin library holding the portable logic (timer, merge, schema,
// store, sync). No Android dependencies, so its tests run on a plain JVM:
//   ./gradlew :core:test
include(":core")

// The Android Wear OS app. It needs the Android SDK to *configure*, so it is
// included only when an SDK is present — Android Studio always has one, and CI
// that only exercises :core does not, so `:core:test` stays runnable headless.
val androidSdkAvailable =
    System.getenv("ANDROID_HOME") != null ||
        System.getenv("ANDROID_SDK_ROOT") != null ||
        file("local.properties").let { it.exists() && it.readText().contains("sdk.dir") }

if (androidSdkAvailable) {
    include(":wear")
} else {
    logger.lifecycle("[focus-log-wear] No Android SDK detected — skipping :wear. Open in Android Studio to build the watch app.")
}
