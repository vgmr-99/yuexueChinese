package com.vietchinese.app

import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger

/**
 * NativeHttp —— 发音评测请求的原生 HTTP 通道
 *
 * ## 为什么必须有这一层
 *
 * APK 里的页面来源是 `file:///android_asset/web/index.html`，
 * 对 `https://` 的 fetch 属于**跨域**：
 *   - Origin 头是 `null`，服务端无法用白名单区分来源；
 *   - 浏览器同源策略会拦下响应，页面只看到一句 `Failed to fetch`；
 *   - `file://` 页面在部分 WebView 版本里根本不允许发跨域请求。
 *
 * 讯飞评测接口又不允许浏览器直连（密钥不能进客户端、也不支持跨域）。
 * 于是链路必须是：**网页 → JS 桥 → 原生 HttpURLConnection → 自己的 PHP 代理 → 讯飞**。
 *
 * ## 为什么用回调而不是同步返回
 *
 * `@JavascriptInterface` 方法若同步做网络请求，会**卡住 WebView 的 JS 线程**
 * 整个请求时长（最长 25 秒）。那段时间里页面所有交互都无响应，
 * 用户看到的是「应用卡死了」。
 *
 * 这里采用异步回调：
 *   1. 网页调 `AthaoHttp.post(url, body, headersJson, reqId)`
 *   2. 原生开线程发请求
 *   3. 完成后回到 UI 线程 `evaluateJavascript("window.__athaoHttpDone(...)")`
 *   4. 网页侧 Promise resolve/reject
 *
 * 响应体用 **base64** 回传，避免任意文本被拼进 JS 字面量造成转义/注入问题。
 */
class NativeHttp(private val activity: MainActivity) {

    companion object {
        private const val TAG = "NativeHttp"
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 25_000
        private const val MAX_RESPONSE_BYTES = 8 * 1024 * 1024
    }

    private val seq = AtomicInteger(0)
    private val main = Handler(Looper.getMainLooper())

    /**
     * 发一个 POST。
     * @param headersJson 形如 `{"Content-Type":"application/json"}` 的 JSON 字符串，可为空
     */
    fun post(url: String, body: String, headersJson: String, reqId: String) {
        Thread({
            var ok = false
            var payload: String
            try {
                payload = doPost(url, body, headersJson)
                ok = true
            } catch (e: Exception) {
                Log.w(TAG, "post failed: ${e.message}")
                payload = e.message ?: e.javaClass.simpleName
            }
            deliver(reqId, ok, payload)
        }, "AthaoHttp").start()
    }

    private fun doPost(url: String, body: String, headersJson: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.doOutput = true
            conn.useCaches = false

            // 默认头 + 网页传来的头（网页可以覆盖）
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.setRequestProperty("Accept", "application/json")
            if (headersJson.isNotBlank()) {
                try {
                    val o = JSONObject(headersJson)
                    val keys = o.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        conn.setRequestProperty(k, o.optString(k, ""))
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "headers 解析失败，忽略自定义头: ${e.message}")
                }
            }

            val bytes = body.toByteArray(Charsets.UTF_8)
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.outputStream.use { it.write(bytes) }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = StringBuilder()
            stream?.use { input ->
                BufferedReader(InputStreamReader(input, Charsets.UTF_8)).use { r ->
                    val buf = CharArray(8192)
                    var n = r.read(buf)
                    while (n > 0) {
                        text.append(buf, 0, n)
                        if (text.length > MAX_RESPONSE_BYTES) break
                        n = r.read(buf)
                    }
                }
            }
            // 非 2xx 也把响应体带回去：网页侧要从 body 里读 error 字段
            if (code !in 200..299) {
                throw HttpError(code, text.toString())
            }
            return text.toString()
        } finally {
            conn.disconnect()
        }
    }

    /** 带 HTTP 状态码的异常，便于网页侧区分「服务端拒绝」与「网络不通」 */
    class HttpError(val code: Int, val payload: String) :
        Exception("HTTP $code")

    /** 把结果回传给网页 */
    private fun deliver(reqId: String, ok: Boolean, payload: String) {
        val b64 = Base64.encodeToString(payload.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        val script = "window.__athaoHttpDone(" +
            quote(reqId) + "," + (if (ok) "true" else "false") + "," + quote(b64) + ");"
        main.post {
            try {
                activity.web.evaluateJavascript(script, null)
            } catch (e: Exception) {
                Log.w(TAG, "回传结果失败: ${e.message}")
            }
        }
    }

    /** 单引号字符串转义（reqId 与 base64 都不含单引号，这里只是兜底） */
    private fun quote(s: String): String =
        "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"

    // ------------------------------------------------------------ 网页门面

    class Bridge(private val http: NativeHttp) {

        /**
         * 发起 POST。**立即返回**，结果通过 `window.__athaoHttpDone` 回调。
         * @param reqId 网页侧自生成的请求号，用于把回调对上号
         */
        @JavascriptInterface
        fun post(url: String, body: String, headersJson: String, reqId: String) {
            http.post(url, body, headersJson, reqId)
        }

        /** 供网页侧确认原生通道可用 */
        @JavascriptInterface
        fun available(): Boolean = true
    }
}
