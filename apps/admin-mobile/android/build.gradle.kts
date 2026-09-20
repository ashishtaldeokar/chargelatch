allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
// esp_provisioning_ble (last released 2023) pins compileSdk 33, which current AndroidX libraries
// refuse to build against. Lift any plugin below 36 up to it. This has to be registered before
// the evaluationDependsOn block below forces the subprojects to evaluate.
subprojects {
    afterEvaluate {
        extensions.findByType<com.android.build.gradle.BaseExtension>()?.let { android ->
            val current = android.compileSdkVersion?.removePrefix("android-")?.toIntOrNull()
            if (current != null && current < 36) android.compileSdkVersion(36)
        }
    }
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
