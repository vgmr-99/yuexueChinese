package com.vietchinese.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * NativeRecorder —— 发音评测的录音器（原生实现）
 *
 * ## 为什么不用网页的 getUserMedia
 *
 * 真机实测（vivo OriginOS / Android 16 / WebView 155）：
 * 同一台手机上**原生 App 录音正常，高德地图成功录过音**，
 * 但 WebView 的 `getUserMedia` 恒定抛
 * `NotReadableError: Could not start audio source`（重试 5 次全败、
 * 权限改成 allow 也无效、系统未静音）。
 * 说明麦克风硬件与系统权限都没问题，是 WebView 媒体栈的问题。
 *
 * 与其继续和 WebView 的音频栈较劲，不如**绕开它**：
 * 这里用 Android 原生 [AudioRecord] 在 Kotlin 侧采集 PCM，
 * 通过 [JavascriptInterface] 把字节交给网页。
 *
 * ## 与网页版的关系
 *
 * 网页版**不需要**这个类 —— 桌面/移动浏览器原生支持 getUserMedia，
 * 继续走网页自己的 Recorder 即可。
 * `speech.js` 会自动探测 `window.AthaoNativeRecorder`：
 * 有就用原生，没有就用 getUserMedia，**同一套上层逻辑两端共用**
 * （16k 重采样、WAV 封装、上传讯飞、结果渲染）。
 *
 * ## 采样格式
 *
 * 直接以 **16000 Hz / 单声道 / PCM 16bit** 采集 —— 讯飞 ISE 只收这个格式，
 * 采集侧就一步到位，网页侧不必再做重采样。
 * 若设备不支持 16k，回落到 44100 并在 [recInfo] 里如实返回真实采样率，
 * 由网页侧重采样（宁可多一步，也不提交错采样率的数据）。
 */
class NativeRecorder(private val activity: MainActivity) {

    companion object {
        private const val TAG = "NativeRecorder"
        const val PREF_RATE = 16000
    }

    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var running = false
    /** 是否有一段已录完、但网页还没来取的结果。
     *  之前用 running 判断，导致 JS 在**录音进行中**调 poll() 恒返回 null，
     *  录音结果永远取不回来。 */
    @Volatile private var hasPending = false
    private val collected = ByteArrayOutputStream()
    private val sampleRates = ArrayList<Int>()

    /** 当前实际采样率（设备不支持 16k 时会变成实际值） */
    @Volatile var currentRate: Int = PREF_RATE
        private set

    val isRecording: Boolean get() = running
    val pending: Boolean get() = hasPending

    /** 音量回调（0~1），供网页画电平条 */
    @Volatile var onLevel: ((Float) -> Unit)? = null

    // ------------------------------------------------------------ 权限

    private fun hasMic(): Boolean =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * 开始录音。
     * @return null 表示成功；否则返回错误码字符串（供网页映射成对应文案）
     */
    @SuppressLint("MissingPermission")
    fun start(): String? {
        if (!hasMic()) return "permission"
        if (running) return null

        // 依次尝试：16000 → 44100（保证拿到的是设备真实支持的参数）
        for (rate in intArrayOf(PREF_RATE, 44100)) {
            val minBuf = AudioRecord.getMinBufferSize(
                rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            if (minBuf <= 0) continue
            val bufSize = minBuf * 2
            try {
                val r = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION, // 关闭 AGC/降噪，更接近真实发音
                    rate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufSize
                )
                if (r.state != AudioRecord.STATE_INITIALIZED) {
                    r.release()
                    continue
                }
                r.startRecording()
                record = r
                hasPending = true
                currentRate = rate
                sampleRates.clear()
                collected.reset()
                running = true
                loop(bufSize, rate)
                Log.i(TAG, "start ok rate=$rate buf=$bufSize")
                return null
            } catch (e: SecurityException) {
                return "permission"
            } catch (e: IllegalStateException) {
                Log.w(TAG, "rate $rate 不可用: ${e.message}")
            }
        }
        Log.w(TAG, "start failed: 所有采样率均不可用")
        return "not_readable"
    }

    /** 采集循环：读 PCM、累积、算电平 */
    private fun loop(bufSize: Int, rate: Int) {
        val buf = ShortArray(bufSize / 2)
        val out = ByteArray(buf.size * 2)
        thread = Thread {
            val r = record ?: return@Thread
            while (running) {
                val n = try {
                    r.read(buf, 0, buf.size)
                } catch (e: IllegalStateException) {
                    break
                }
                if (n <= 0) continue
                // short -> little-endian bytes（讯飞要 16bit PCM LE）
                var peak = 0
                for (i in 0 until n) {
                    val v = buf[i].toInt()
                    out[i * 2] = (v and 0xFF).toByte()
                    out[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
                    val a = if (v < 0) -v else v
                    if (a > peak) peak = a
                }
                synchronized(collected) { collected.write(out, 0, n * 2) }
                if (sampleRates.size < 1) sampleRates.add(rate)
                if (onLevel != null) onLevel!!.invoke(peak / 32768f)
            }
        }.apply {
            name = "AthaoRecorder"
            priority = Thread.NORM_PRIORITY + 2
            start()
        }
    }

    /**
     * 停止并返回录音结果。
     * @return Map：ok/ms/rate/bytes（bytes 是 base64 的 PCM16LE 单声道）
     */
    fun stop(): Map<String, Any?> {
        hasPending = false
        running = false
        try { thread?.join(400) } catch (e: InterruptedException) { }
        thread = null
        try { record?.stop() } catch (e: IllegalStateException) { }
        try { record?.release() } catch (e: Exception) { }
        record = null

        val pcm: ByteArray = synchronized(collected) { collected.toByteArray() }
        val ms = if (currentRate > 0) pcm.size / 2L * 1000L / currentRate else 0L
        Log.i(TAG, "stop bytes=${pcm.size} ms=$ms rate=$currentRate")
        return mapOf(
            "ok" to true,
            "ms" to ms,
            "rate" to currentRate,
            "bytes" to android.util.Base64.encodeToString(pcm, android.util.Base64.NO_WRAP)
        )
    }

    /** 放弃本次录音 */
    fun cancel() {
        running = false
        try { thread?.join(200) } catch (e: InterruptedException) { }
        thread = null
        try { record?.stop() } catch (e: IllegalStateException) { }
        try { record?.release() } catch (e: Exception) { }
        record = null
        synchronized(collected) { collected.reset() }
    }

    /**
     * 给网页用的门面。
     * 网页侧只跟这四个方法打交道，录音细节全在 Kotlin 侧。
     */
    class Bridge(private val rec: NativeRecorder, private val activity: MainActivity) {

        @JavascriptInterface
        fun available(): Boolean = true

        /**
         * 开始录音。网页随后轮询 [poll] 取结果 —— 这样跨语言只传字符串/数字，
         * 不会碰到「原生抛异常、网页收不到」的老问题。
         *
         * 返回空串表示已开始；返回 `"permission"` 表示**系统层麦克风权限未授予**，
         * 网页应转而调用 [requestPermission] 走系统授权流程。
         */
        @JavascriptInterface
        fun start(): String {
            val err = rec.start()
            return if (err == null) "" else err
        }

        /**
         * 主动申请系统麦克风权限。
         *
         * ## 为什么必须由网页显式触发
         *
         * 原生 [AudioRecord] 录音**不经过 WebView 的 getUserMedia**，
         * 所以 `onPermissionRequest` 里那套 `ensureMicPermission` 根本不会被触发，
         * 系统 `RECORD_AUDIO` 从未被申请过 —— 结果就是：
         * 首次安装 App 后点「发音评测」，永远返回 permission 错误，
         * 而用户在 APK 里又找不到浏览器地址栏可以授权。
         *
         * 现在网页在 `start()` 拿到 permission 错误码时，会显式调用本方法，
         * 由原生弹出系统授权对话框。
         *
         * @return `"granted"` 已授权 / `"pending"` 已弹窗，等待用户选择
         */
        @JavascriptInterface
        fun requestPermission(): String {
            if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
            ) {
                return "granted"
            }
            activity.requestMicPermission()
            return "pending"
        }

        /** 取结果：没录完返回 null，录完返回 {ok,ms,rate,bytes} */
        @JavascriptInterface
        fun poll(): String? {
            // 网页在「停止录音」这一刻调用本方法，此时正在录音是正常的，
            // 所以不能用 isRecording 当作「还没录完」的判据 ——
            // 那样会导致永远取不到结果。改用 hasPending：
            // start() 置位、stop() 清零。
            if (!rec.hasPending) return null
            val r = rec.stop()
            return org.json.JSONObject(r as Map<*, *>).toString()
        }

        @JavascriptInterface
        fun cancel() {
            rec.cancel()
        }

        @JavascriptInterface
        fun hasPermission(): Boolean =
            ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
    }
}
