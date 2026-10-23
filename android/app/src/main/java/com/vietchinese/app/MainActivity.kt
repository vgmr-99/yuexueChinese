package com.vietchinese.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * MainActivity — Athao 学汉语 WebView 套壳
 *
 * 设计要点
 * --------
 * 1. 学习内容全部打包在 assets/web 里，**不依赖网络即可完整使用**。
 * 2. WebView 启用 JS + DOM Storage（localStorage 存学习进度）与媒体播放。
 * 3. 发音默认走预生成 MP3 / 系统 TTS，不联网。
 * 4. 可选的**在线增强**：发音评测（讯飞 ISE）。它必须经由用户自己的
 *    PHP 中转服务调用——密钥不能进 APK，且 WebView 无法直连讯飞。
 *    未配置时该入口自动禁用，其余功能完全不受影响。
 * 5. 物理返回键：先让网页处理（如关闭弹窗），再决定是否退出 App。
 * 6. **边到边（edge-to-edge）**：内容延伸到刘海/手势条区域，
 *    由网页 CSS 的 env(safe-area-inset-*) 负责避让，
 *    这样既不出现黑边，也不会让内容被刘海或手势条遮住。
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var root: FrameLayout
    private lateinit var nativeRecorder: NativeRecorder

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 边到边：允许内容画到状态栏与导航栏区域，
        // 真实 inset 交给 CSS env() 处理（需配合 viewport-fit=cover）
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // 红底 header 用浅色（白色）状态栏图标，保证可读
        WindowInsetsControllerCompat(window, window.decorView)
            .isAppearanceLightStatusBars = false

        root = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true          // localStorage：学习进度
                allowFileAccess = true            // 读取 assets 下的音频
                // 资源全部打包在 APK 内，每次都用磁盘里的最新版本。
                // 仅设 LOAD_NO_CACHE 还不够——WebView 对 file:// 资源
                // 仍会在内存层缓存，导致装新包后 JS 仍是旧代码
                // （真机表现为标题、词库看起来没更新）。
                cacheMode = WebSettings.LOAD_NO_CACHE
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.KITKAT) {
                    settings.setCacheMode(WebSettings.LOAD_NO_CACHE)
                }
                // 允许 file:// 读取本地资源（音频/数据）
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = true
                // 固定 100%：系统字号放大会让排版溢出，移动端 App 自行控制
                textZoom = 100
                // 中文/越语混排，用系统默认字体即可
                builtInZoomControls = false
            }

            // 允许 <audio> 自动播放（听写/发音不能等用户手势）
            settings.mediaPlaybackRequiresUserGesture = false

            // 调试期：把网页 console / 资源加载错误打到 logcat，
            // tag = WebViewJS / WebViewErr，用于根因定位（发布版可移除）
            WebView.setWebContentsDebuggingEnabled(true)

            // 全部走本地资源，禁止跳出到外部网页
            webViewClient = object : WebViewClient() {

                override fun shouldOverrideUrlLoading(
                    view: WebView?, request: android.webkit.WebResourceRequest?
                ): Boolean {
                    val url = request?.url?.toString() ?: return false
                    // 仅允许虚拟 https 来源内部跳转
                    return !url.startsWith("file:///android_asset/")
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: android.webkit.WebResourceRequest?,
                    error: android.webkit.WebResourceError?
                ) {
                    Log.w("WebViewErr", "URL=" + request?.url +
                        " code=" + error?.errorCode + " desc=" + error?.description)
                }

                override fun onReceivedHttpError(
                    view: WebView?,
                    request: android.webkit.WebResourceRequest?,
                    errorResponse: android.webkit.WebResourceResponse?
                ) {
                    Log.w("WebViewErr", "HTTP URL=" + request?.url +
                        " status=" + errorResponse?.statusCode)
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                    consoleMessage ?: return true
                    Log.w("WebViewJS", consoleMessage.message() +
                        " -- line " + consoleMessage.lineNumber() +
                        " of " + consoleMessage.sourceId())
                    return true
                }

                /**
                 * 发音评测需要网页调用 getUserMedia 录音。
                 *
                 * WebView 不会自动继承系统麦克风权限：**必须**在
                 * onPermissionRequest 里显式 grant，否则网页的
                 * navigator.mediaDevices.getUserMedia 会直接抛
                 * NotAllowedError，且界面上没有任何提示（很难排查）。
                 *
                 * 这里只放行麦克风，且要求来源与请求方一致；
                 * 其余资源（相机、定位等）一律拒绝——本应用不需要。
                 */
                override fun onPermissionRequest(request: PermissionRequest?) {
                    val req = request ?: return
                    val origin = req.origin?.toString() ?: ""
                    val wantsMic = req.resources.any {
                        it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                    }
                    if (wantsMic && isTrustedOrigin(origin)) {
                        ensureMicPermission { granted ->
                            if (granted) {
                                req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                            } else {
                                req.deny()
                            }
                        }
                    } else {
                        Log.w("WebViewJS", "denied media request from " + origin)
                        req.deny()
                    }
                }

                override fun onPermissionRequestCanceled(request: PermissionRequest?) {
                    // 用户切走页面时系统会撤销，录音会自动中止；此处无需处理
                }
            }
        }

        // 发音评测录音：走原生 AudioRecord，绕开 WebView 媒体栈
        // （实测 WebView 的 getUserMedia 在部分 OEM 上恒定失败）
        nativeRecorder = NativeRecorder(this)
        webView.addJavascriptInterface(
            NativeRecorder.Bridge(nativeRecorder, this),
            "AthaoNativeRecorder"
        )

        root.addView(webView)
        setContentView(root)

        // 加载打包在 assets 里的应用
        webView.loadUrl("file:///android_asset/web/index.html")

        // 返回键：优先交给网页（如关闭笔顺弹窗），否则退出
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("window.__onAndroidBack && window.__onAndroidBack()") { result ->
                    if (result == "true") {
                        // 网页已处理，本次不退出
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
    }

    /**
     * 只有打包在 assets 里的页面才允许使用麦克风。
     * 防住「万一页面里出现外部内容/跳转后借用麦克风」的情况。
     */
    private fun isTrustedOrigin(origin: String): Boolean =
        origin.isEmpty() || origin.startsWith("file://")

    private var pendingMicCallback: ((Boolean) -> Unit)? = null

    private val micPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            Log.i("WebViewJS", "RECORD_AUDIO granted=" + granted)
            pendingMicCallback?.invoke(granted)
            pendingMicCallback = null
        }

    /**
     * 确保系统层麦克风权限已授予。
     * WebView 授权与系统授权是两层，必须都过；已授予时直接回调，
     * 避免每次录音都弹系统对话框。
     */
    private fun ensureMicPermission(callback: (Boolean) -> Unit) {
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) {
            callback(true)
        } else {
            pendingMicCallback = callback
            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // 保存 WebView 状态（滚动位置/当前页面），
        // 否则进程被系统回收后重建会退回首页，用户以为进度丢了
        webView.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        webView.restoreState(savedInstanceState)
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        root.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }
}