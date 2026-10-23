plugins {
    // 构建环境用JDK 17（Temurin 17.0.20.1），
    // 配AGP 8.2.2 + Kotlin 1.9.22 —— 已在该组合上验证可构建。
    //
    // 注意：不要切到 JDK 25（Android Studio 自带的 jbr）。
    // Kotlin 低版本编译器内置的IntelliJ 解析不了 Java 25，
    // 会抛 `IllegalArgumentException: 25.0.3`，
    // 且报错信息只有版本号，极难定位。
    // 若将来要用 JDK 21+，AGP 与 Kotlin 都需同步升级到 8.5+ / 2.1+。
    id("com.android.application") version "8.2.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
}