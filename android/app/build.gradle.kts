plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.vietchinese.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.vietchinese.app"
        // WebView API 21+ 即可；这里设 28 与译境保持一致
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-research"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 研究用途，用 debug 签名即可安装；正式发布请换成自己的 keystore
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // 关键：把 ../../web 整包同步到 assets/web，APK 完全离线
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets")
        }
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
}

/**
 * 构建前把web/ 同步进 assets/web。
 * 这样web 端改完直接重新 build 即可，不用手工复制。
 */
val syncWebAssets by tasks.registering(Copy::class) {
    from(rootProject.file("../web"))
    into(layout.projectDirectory.dir("src/main/assets/web"))
}

tasks.named("preBuild") {
    dependsOn(syncWebAssets)
}

/**
 * 给已同步的 index.html 追加 ?v=构建时间戳。
 *
 * 为什么要：WebView 即使设了 LOAD_NO_CACHE，对 file:// 资源仍会缓存，
 * 导致「装了新包但界面还是旧的」（真机上表现为标题、词库没更新）。
 * 加版本号让 URL 变化，强制 WebView 重新加载。
 */
val stampVersion by tasks.registering {
    dependsOn(syncWebAssets)
    doLast {
        // 注意：project.file() 返回 File（非空）。
        // Kotlin DSL 的 doLast {} 闭包里不能用 return，所以用 if/else。
        val html = file("src/main/assets/web/index.html")
        if (html.exists()) {
            val ver = System.currentTimeMillis().toString().takeLast(8)
            var text = html.readText()
            // 先清掉旧版本号。
            //
            // 注意：这里必须匹配十六进制，不能只写 \d+。
            // tools/stamp_version.py 打的是 sha1 前 8 位（十六进制，如 6c36474f），
            // 只匹配数字的话清不掉旧值，结果就是
            //   js/app.js?v=f74eb668?v=96510695   ← 双查询串
            // 虽然 WebView 取的是第一个 ? 之前的路径、照样能跑，
            // 但内容哈希就完全失去意义了（每次构建全量重下）。
            text = Regex("\\?v=[0-9a-zA-Z_-]+").replace(text, "")

            // 再给所有**本地静态资源**统一打上新戳。
            // 不能只处理 <script> / <link>：<img src="images/logo-panda.png"> 也要打，
            // 否则清完旧戳就再也加不回来了（logo 会退回浏览器缓存的旧图）。
            // 同时必须排除：
            //   - 外部地址（http/https///）
            //   - 页内锚点（href="#i-xxx"，SVG symbol 引用）
            val staticExt = Regex("\\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|json)$")
            text = Regex("((?:src|href)=\"(?!https?:|data:|//|#)([^\"]+)\")").replace(text) { m ->
                val path = m.groupValues[2]
                if (staticExt.containsMatchIn(path)) {
                    m.groupValues[1].dropLast(1) + "?v=" + ver + "\""
                } else {
                    m.value
                }
            }
            html.writeText(text)
            logger.lifecycle("已为本地资源打版本号 ?v=" + ver + "（绕过 WebView 缓存）")
        } else {
            logger.lifecycle("未找到 index.html，跳过版本号处理")
        }
    }
}

tasks.named("preBuild") {
    dependsOn(stampVersion)
}