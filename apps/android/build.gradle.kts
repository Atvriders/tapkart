buildscript {
    val kotlinPluginVersion = project.property("tapkartKotlinPluginVersion") as String

    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        // Both versions come from the Capacitor 8.5.0 template unchanged.
        classpath("com.android.tools.build:gradle:8.13.0")
        classpath("com.google.gms:google-services:4.4.4")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinPluginVersion")
    }
}

// Capacitor-managed Groovy. It defines the SDK and AndroidX version extras.
apply(from = "variables.gradle")

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
