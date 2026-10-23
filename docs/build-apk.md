# 打 APK 指南（WebView 套壳）

## 环境要求

| 项 | 版本 | 说明 |
|----|------|------|
| JDK | **17**（不要用 21/25） | 见下方「踩坑 1」，Kotlin 编译器解析不了 Java 25 |
| Gradle | 8.10.2 | 你本机已缓存 `gradle-8.10.2-bin` |
| Android SDK | compileSdk 36 | 需 platform 36 + build-tools 36.0.0 |
| minSdk | 28 | 与译境保持一致 |

### 本机可用路径（2026-10-17 实测）

| 组件 | 路径 |
|------|------|
| **JDK 17（构建用这个）** | `D:\ruanjian\kaifaHuanJing\jdk17` |
| JDK 25（Studio 自带，**不能用**） | `C:\Program Files\Android\Android Studio\jbr` |
| Android SDK | `D:\ruanjian\kaifaHuanJing\android-sdk` |
| Gradle 8.10.2 | `D:\ruanjian\kaifaHuanJing\gradle-cache\wrapper\dists\gradle-8.10.2-bin\a04bxjujx95o3nb99gddekhwo\gradle-8.10.2` |
| adb | `D:\ruanjian\kaifaHuanJing\android-sdk\platform-tools\adb.exe` |

### 命令行一键构建（PowerShell）

```powershell
$env:JAVA_HOME = 'D:\ruanjian\kaifaHuanJing\jdk17'
$env:ANDROID_HOME = 'D:\ruanjian\kaifaHuanJing\android-sdk'
$env:GRADLE_USER_HOME = 'D:\ruanjian\kaifaHuanJing\gradle-cache'
$gradle = 'D:\ruanjian\kaifaHuanJing\gradle-cache\wrapper\dists\gradle-8.10.2-bin\a04bxjujx95o3nb99gddekhwo\gradle-8.10.2\bin\gradle.bat'
cd 'C:\Users\PC\WorkBuddy\2026-10-16-13-34-21\viet-chinese-app\android'
& $gradle assembleDebug --no-daemon --console=plain
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

---

## 踩坑记录（实战踩过的坑）

### 坑 1：报错只有「25.0.3」三个字符

用 Android Studio 自带的 JDK 25 构建时，Gradle 只报一句：

```
* What went wrong:
25.0.3
```

**原因**：Kotlin 编译器（1.9.x / 2.0.x）内置的 IntelliJ 解析不了 Java 25 的版本号，
抛 `IllegalArgumentException: 25.0.3`。注意这是 **Kotlin** 的问题，不是 AGP——
所以单纯升级 AGP 到 8.5.2 并不能解决。

**解决**：改用 JDK 17。AGP 8.2.2 + Kotlin 1.9.22 在 JDK 17 上可正常构建。
> 将来若必须用 JDK 21+，需AGP ≥ 8.5且 Kotlin ≥ 2.1。

### 坑 2：colorPrimary 找不到

```
error: style attribute 'attr/colorPrimary' not found
```

**原因**：`<item name="colorPrimary">` 少了 `android:` 前缀，
被当成 AppCompat 属性，但项目未引入 AppCompat 依赖。

**解决**：写 `android:colorPrimary` / `android:colorPrimaryDark` / `android:colorAccent`。

### 坑 3：项目缺 gradle-wrapper.jar

仓库里没有 wrapper jar，无法直接跑 `./gradlew`。
已手工补 `gradle-wrapper.properties`（指向 8.10.2），
但 jar 仍缺，**需用本机Gradle 发行版构建**（`gradle.bat assembleDebug`）。

### 坑 4：bash 写 local.properties 转义被吃掉

在 bash 里写 `sdk.dir=D\:\\...` 会被转义规则破坏，Gradle 读不到路径。
**解决**：用 PowerShell 的 `[System.IO.File]::WriteAllText` 写 Properties 文件。

### SDK 组件补装

原 SDK 只有 android-34/35，项目要 compileSdk 36，已补装：

```bash
sdkmanager --sdk_root="D:/ruanjian/kaifaHuanJing/android-sdk" \
  "platforms;android-36" "build-tools;36.0.0"
```

### 安装到手机

```bash
adb devices                      # 需显示 device，而非 unauthorized
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

首次连接若显示 `unauthorized`，需在手机上确认「允许 USB 调试」，
并勾选「一律允许使用这台计算机进行调试」。

---

## 方式一：Android Studio（推荐）

1. Android Studio → **Open** → 选 `viet-chinese-app/android` 目录
2. 等待 Gradle Sync 完成（会自动下载 AGP 8.2.2 / Kotlin 1.9.22）
3. **重要**：Studio 自带的是 JDK 25，需在 Settings → Build Tools → Gradle →
   Gradle JDK 改选 **JDK 17**（`D:\ruanjian\kaifaHuanJing\jdk17`），否则构建会失败
3. 菜单 **Build → Build Bundle(s) / APK(s) → Build APK(s)**
4. 产物：`android/app/build/outputs/apk/debug/app-debug.apk`
5. 装到手机：
   ```bash
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```

## 方式二：命令行

```bash
cd viet-chinese-app/android

# 若需指定 SDK 路径
export ANDROID_HOME=/c/Users/PC/AppData/Local/Android/Sdk

./gradlew assembleDebug
# 或用本机gradle 8.9
gradle assembleDebug
```

## 构建时自动同步 Web 资源

`app/build.gradle.kts` 里注册了 `syncWebAssets` 任务，
**每次 build 会自动把 `../web/` 复制到 `app/src/main/assets/web/`**。

所以改了网页内容后，**直接重新 build 即可**，不需要手工复制。

## 离线保证

- 所有资源（词库、笔顺、拼音 MP3、hanzi-writer）都在 `assets/web/` 内
- `MainActivity` 用 `file:///android_asset/web/index.html` 加载
- `shouldOverrideUrlLoading` 拦截外部跳转，无法联网
- 体积约 1.4 MB（web）+ 笔顺数据

## 签名说明

当前 `release` 也用 debug 签名（研究用途够用，可直接安装）。
若要正式分发，需自建 keystore：

```bash
keytool -genkey -v -keystore release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias mykey
```

然后在 `app/build.gradle.kts` 增加 `signingConfigs.release` 并替换。

## 常见报错

| 报错 | 原因 | 解决 |
|------|------|------|
| `SDK location not found` | 未配置 SDK | 设 `ANDROID_HOME` 或在 local.properties 写 `sdk.dir=...` |
| `Failed to find target android-36` | 缺 Platform 36 | SDK Manager 勾选 Android 16 (API 36) |
| `usesCleartextTraffic` 报错 | 约束冲突 | 已设为 false，仅本地资源无需网络 |
| 页面空白 | assets 未同步 | 手动执行 `gradle syncWebAssets` 后重新 build |
| 中文显示为方框 | 缺中文字体 | WebView 需系统含中文字体，vivo/小米 等国行机均有 |

## 真机验证清单

装好后按顺序检查：

- [ ] 首页显示 152 词 / 15 课
- [ ] 词卡显示 `🀄` 汉越音行
- [ ] 点词卡 → 弹出笔顺动画（单字直接播放，多字词先选字）
- [ ] 「✍️ Tập viết」描红测验可写
- [ ] 拼音页点击发音播放本地 MP3
- [ ] 课程页句子点击朗读 + 显示汉越音
- [ ] 测验页 10 题可作答并出分数
- [ ] 标记已学后，进度数字变化且**杀进程重启后仍在**（localStorage）
- [ ] 飞行模式下功能完整（完全离线）
---

## v2 更新（2026-10-16）

### 体积变化

| 内容 | 体积 |
|------|------|
| 词库数据（app-data.js） | 780 KB |
| 笔顺（strokes.json，1,021 字） | 2.2 MB |
| 预生成音频（2,194 个 mp3） | 23.5 MB |
| 拼音音频 + JS/CSS | ~3 MB |
| **web 合计** | **约 30 MB** |

APK 预计 **30–35 MB**（含 assets 压缩）。仍属轻量，可接受。

> `data/tts/`（121 MB 模型）**不进 APK**，仅用于离线重新生成音频。

### 真机验证清单（v2 新增）

- [ ] 顶部语言切换 **中/ VI / EN** 生效，导航与文案随之变化
- [ ] 切到英文后词卡释义变英文，切越南语变越南语
- [ ] 语言选择**重启后保留**（localStorage）
- [ ] 「Học từ」页有 HSK 1/2/3 等级标签，点击可筛选
- [ ] 点词卡播放**预生成音频**（非系统 TTS），离线也能响
- [ ] 「Ôn tập」SRS 页显示三个统计数字，点开始出题
- [ ] SRS 答对后间隔递增（1→6→16 天），答错重置为 1 天
- [ ] HSK2 词（如 银行）也能看笔顺
- [ ] 2245 词全部有 🔊 标记

### 重新生成音频

```bash
VP=../.workbuddy/binaries/python/envs/default/Scripts/python.exe

# Edge TTS（音质最好，需联网）
$VP tools/build_audio.py --vocab data/vocab.json \
  --out web/audio/words --engine edge --levels 1,2,3

# 离线回退（sherpa-onnx，无网可用，音质略逊）
$VP tools/build_audio.py --vocab data/vocab.json \
  --out web/audio/words --engine sherpa --levels 1
```

> Edge TTS 生成后音频已打包，**App 运行时不再需要网络**。
> 增量生成：已存在的文件会跳过，可安全重跑。

---

## v3 更新（HSK 1-6）

### 体积（实测）

| 内容 | 体积 |
|------|------|
| app-data.js（5,456 词三语数据） | 1.8 MB |
| strokes.json（1,887 字） | 4.6 MB |
| audio/words（5,344 个 mp3） | 57 MB |
| 拼音音频 + JS/CSS | ~4 MB |
| **web 合计** | **约 71 MB** |

APK 预计 **70–80 MB**。音频占大头，属预期内。

> 若要压体积：`build_audio.py --levels 1,2` 只生成 HSK1-2 音频，
> 可省约 40 MB。`data/tts/` 模型不进 APK。

### 数据已达 100% 覆盖

越南语 / 英文 / 汉越音 三项对 HSK1-6 全部 5,456 词均为 100%。

### 分页加载

词卡每页 300、笔顺每页 600，超出显示「加载更多」按钮，
避免 HSK6（1,140 词）一次性渲染卡顿。

### 真机验证新增项

- [ ] HSK 等级标签显示 1–6，计数正确（500/772/973/1000/1071/1140）
- [ ] 切到 HSK6，点「加载更多」可继续加载
- [ ] 笔顺页可翻到 1,887 字，有分页
- [ ] 抽查 HSK4-6 词（如 银行/谢谢）汉越音、释义、音频均正常
