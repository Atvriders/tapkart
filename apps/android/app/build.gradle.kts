import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Values supplied by the generated variables.gradle.
val capacitorMinSdk = (rootProject.extra["minSdkVersion"] as Number).toInt()
val templateTargetSdk = (rootProject.extra["targetSdkVersion"] as Number).toInt()
val androidxAppCompatVersion: String by rootProject.extra
val androidxCoordinatorLayoutVersion: String by rootProject.extra
val androidxCoreVersion: String by rootProject.extra
val coreSplashScreenVersion: String by rootProject.extra
val junitVersion: String by rootProject.extra
val androidxJunitVersion: String by rootProject.extra
val androidxEspressoCoreVersion: String by rootProject.extra

// Values recorded by Task 13 in gradle.properties.
val tapkartApplicationId = project.property("tapkartApplicationId") as String
val android16ApiLevel =
    (project.property("tapkartAndroid16ApiLevel") as String).trim().toInt()

val tapkartTargetSdk = maxOf(templateTargetSdk, android16ApiLevel)
val tapkartMinSdk = maxOf(capacitorMinSdk, 26)

val tapkartKeystorePath = System.getenv("TAPKART_KEYSTORE_PATH")
val tapkartKeystorePassword = System.getenv("TAPKART_KEYSTORE_PASSWORD")
val tapkartKeyAlias = System.getenv("TAPKART_KEY_ALIAS")
val tapkartKeyPassword = System.getenv("TAPKART_KEY_PASSWORD")

// CI decodes the key outside the checkout. Committing it once compromises it
// forever, so a path anywhere under this repository is a configuration error.
tapkartKeystorePath?.let { path ->
    val store = File(path).canonicalFile
    val tree = rootProject.projectDir.resolve("../..").canonicalFile
    check(store != tree && !store.path.startsWith(tree.path + File.separator)) {
        "TAPKART_KEYSTORE_PATH points inside the Gradle project tree ($store) — " +
            "keep the keystore outside the checkout, and out of the repository forever"
    }
}

val tapkartSigningValues =
    listOf(tapkartKeystorePath, tapkartKeystorePassword, tapkartKeyAlias, tapkartKeyPassword)
val tapkartSigningValueCount = tapkartSigningValues.count { !it.isNullOrBlank() }
check(tapkartSigningValueCount == 0 || tapkartSigningValueCount == tapkartSigningValues.size) {
    "release signing requires all four TAPKART_KEYSTORE_* variables, or none of them"
}
val tapkartReleaseSigningEnabled = tapkartSigningValueCount == tapkartSigningValues.size

android {
    namespace = tapkartApplicationId
    compileSdk = tapkartTargetSdk

    // Both language implementations replay these exact published vectors.
    sourceSets["test"].resources.srcDir("$rootDir/../../packages/invite/vectors")

    defaultConfig {
        applicationId = tapkartApplicationId
        minSdk = tapkartMinSdk
        targetSdk = tapkartTargetSdk
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // The APK's verified host and its native WebView origin share this one
        // build variable. The reserved default makes an unconfigured debug APK
        // harmless; release CI supplies TAPKART_ORIGIN.
        val tapkartOrigin =
            (project.findProperty("tapkartOrigin") as String?)
                ?: System.getenv("TAPKART_ORIGIN")
                ?: "https://tapkart.example"
        check(tapkartOrigin.startsWith("https://")) {
            "tapkartOrigin must be an https origin (got '$tapkartOrigin'). The intent filter's " +
                "scheme is https and nothing else will ever match it."
        }
        val hostAndPort = tapkartOrigin.removePrefix("https://")
        check(Regex("[A-Za-z0-9.-]+(?::[0-9]{1,5})?").matches(hostAndPort)) {
            "tapkartOrigin '$tapkartOrigin' does not yield a host"
        }
        val tapkartHost = hostAndPort.substringBefore(':')

        // Generated from @tapkart/protocol's LOBBY_PATH_PREFIX. Ordinary Kotlin
        // interpolation is intentional: Gradle must read the real root path.
        val inviteConstants = Properties()
        project.file("$rootDir/gradle/invite-constants.properties").inputStream().use {
            inviteConstants.load(it)
        }
        val tapkartLobbyPathPrefix =
            inviteConstants.getProperty("tapkartLobbyPathPrefix")
                ?: error(
                    "gradle/invite-constants.properties has no tapkartLobbyPathPrefix. " +
                        "Run: node apps/android/scripts/write-invite-constants.mjs",
                )

        manifestPlaceholders["tapkartHost"] = tapkartHost
        manifestPlaceholders["tapkartPathPrefix"] = tapkartLobbyPathPrefix

        @Suppress("UnstableApiUsage")
        aaptOptions {
            ignoreAssetsPattern =
                "!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~"
        }
    }

    signingConfigs {
        create("release") {
            // AGP 8.13 cannot package a variant assigned to an incomplete config.
            // Populate this only in the all-four environment mode.
            if (tapkartReleaseSigningEnabled) {
                storeFile = project.file(requireNotNull(tapkartKeystorePath))
                storePassword = requireNotNull(tapkartKeystorePassword)
                keyAlias = requireNotNull(tapkartKeyAlias)
                keyPassword = requireNotNull(tapkartKeyPassword)
            }
        }
    }

    buildTypes {
        getByName("release") {
            if (tapkartReleaseSigningEnabled) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

// Complete credentials must select the stable config. With no credentials the
// variant must remain unsigned so fork pull requests can still build.
afterEvaluate {
    val configured = android.buildTypes.getByName("release").signingConfig?.name
    if (tapkartReleaseSigningEnabled) {
        check(configured == "release") {
            "the release build type must use signingConfigs.release (found: ${configured ?: "none"}) " +
                "— see README, 'Signing the Android app'"
        }
    } else {
        check(configured == null) {
            "the no-credentials release build must remain unsigned (found: $configured)"
        }
    }
}

repositories {
    flatDir {
        dirs("../capacitor-cordova-android-plugins/src/main/libs", "libs")
    }
}

dependencies {
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.jar"))))
    implementation("androidx.appcompat:appcompat:$androidxAppCompatVersion")
    implementation("androidx.coordinatorlayout:coordinatorlayout:$androidxCoordinatorLayoutVersion")
    implementation("androidx.core:core-ktx:$androidxCoreVersion")
    implementation("androidx.core:core-splashscreen:$coreSplashScreenVersion")
    implementation(project(":capacitor-android"))
    implementation(project(":capacitor-cordova-android-plugins"))
    testImplementation("junit:junit:$junitVersion")
    androidTestImplementation("androidx.test.ext:junit:$androidxJunitVersion")
    androidTestImplementation("androidx.test.espresso:espresso-core:$androidxEspressoCoreVersion")
}

// Generated by `cap sync`; deliberately remains Groovy.
apply(from = "capacitor.build.gradle")

// Preserve the template's optional Google Services integration.
val servicesJson = file("google-services.json")
if (servicesJson.isFile && servicesJson.readText().isNotBlank()) {
    apply(plugin = "com.google.gms.google-services")
} else {
    logger.info(
        "google-services.json not found, google-services plugin not applied. " +
            "Push Notifications won't work",
    )
}

tasks.register("printTapkartPins") {
    val values = listOf(
        "applicationId=${android.defaultConfig.applicationId}",
        "namespace=${android.namespace}",
        "compileSdk=${android.compileSdk}",
        "minSdk=${android.defaultConfig.minSdk}",
        "targetSdk=${android.defaultConfig.targetSdk}",
        "android16ApiLevel=$android16ApiLevel",
    )
    doLast { values.forEach(::println) }
}
