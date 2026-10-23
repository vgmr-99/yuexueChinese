/* speech.js — 发音评测模块（讯飞 ISE WebAPI 客户端）
 *
 * 设计要点
 * --------
 * 1. 录音必须走 Web Audio 的 ScriptProcessorNode 拿裸 PCM，
 *    不能用 MediaRecorder（它产出 webm/opus，讯飞只收 16k/16bit/单声道 WAV）。
 * 2. API 密钥永不进客户端：只与自家 PHP 代理通信，代理再转发讯飞。
 * 3. 未配置后端时优雅降级：明确提示如何开启，不静默失败。
 * 4. 采样率强制 16k（讯飞硬要求），不一致时线性重采样。
 */
(function (global) {
  'use strict';

  var CFG_KEY = 'vietchinese.iseEndpoint';
  var DISABLED = '__off__';
  /** 内置默认评测服务地址（自建 PHP 中转，密钥在服务端，客户端不含凭证） */
  var DEFAULT_ENDPOINT = 'https://kimthao.22web.org/api/ise.php';
  var TARGET_RATE = 16000;
  var MAX_MS = 15000;      // 单次最长录音
  var MIN_MS = 700;        // 太短讯飞会报 10110

  // ------------------------------------------------------------ 配置

  /**
   * 读取评测服务地址。
   * - 从未设置过 → 返回内置默认地址（开箱即用）
   * - 显式设为空  → 返回 ''，功能关闭
   * - 自定义地址   → 返回自定义值
   */
  function endpoint() {
    try {
      var v = localStorage.getItem(CFG_KEY);
      if (v === null) return DEFAULT_ENDPOINT;
      if (v === DISABLED) return '';
      return v.trim();
    } catch (e) {
      return DEFAULT_ENDPOINT;
    }
  }

  function setEndpoint(url) {
    try {
      if (url === null || url === undefined) {
        localStorage.removeItem(CFG_KEY);
      } else {
        var t = String(url).trim();
        localStorage.setItem(CFG_KEY, t || DISABLED);
      }
    } catch (e) { /* ignore */ }
  }

  /** 恢复为内置默认地址 */
  function resetEndpoint() { setEndpoint(null); }
  function configured() { return endpoint().length > 0; }

  // ------------------------------------------------------------ 音频工具

  function writeStr(view, off, s) {
    for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  }

  /** Float32 [-1,1] @ sampleRate -> 16bit PCM WAV（Uint8Array） */
  function toWav16(samples, sampleRate) {
    var n = samples.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    writeStr(v, 0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    writeStr(v, 8, 'WAVE');
    writeStr(v, 12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);            // PCM
    v.setUint16(22, 1, true);            // 单声道
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    writeStr(v, 36, 'data');
    v.setUint32(40, n * 2, true);
    var off = 44;
    for (var i = 0; i < n; i++) {
      var s = samples[i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
    return new Uint8Array(buf);
  }

  /** 线性重采样到 16k */
  /**
   * base64 → Float32Array（16bit little-endian PCM）
   *
   * 原生录音（Kotlin AudioRecord）把 PCM16LE 以 base64 传过来，
   * 这里解回 [-1, 1] 的浮点样本，交给后面的 WAV 封装，
   * 上层流程与网页录音完全一致。
   */
  function base64ToFloat32(b64) {
    var bin;
    if (global.atob) {
      bin = global.atob(b64);
    } else if (global.Buffer) {
      // 极端兜底：Node 环境下调试用
      var buf = global.Buffer.from(b64, 'base64');
      bin = '';
      for (var i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    } else {
      return new Float32Array(0);
    }
    var n = (bin.length >> 1);
    var out = new Float32Array(n);
    for (var j = 0; j < n; j++) {
      var lo = bin.charCodeAt(j * 2);
      var hi = bin.charCodeAt(j * 2 + 1);
      out[j] = ((hi << 8) | lo) / 32768;
    }
    return out;
  }

  function resample(input, from, to) {
    if (from === to) return input;
    var ratio = from / to;
    var outLen = Math.floor(input.length / ratio);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var i1 = Math.min(i0 + 1, input.length - 1);
      var frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  function toBase64(bytes) {
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return global.btoa(parts.join(''));
  }

  /** 录音时长(ms)：字节数 / 采样率 / 2 * 1000 */
  function wavDurationMs(byteLen, rate) {
    return Math.round((byteLen - 44) / 2 / rate * 1000);
  }

  // ------------------------------------------------------------ 录音器

  function Recorder() {
    this.stream = null;
    this.ctx = null;
    this.proc = null;
    this.chunks = [];
    this.rate = TARGET_RATE;
    this.onLevel = null;
    this.onTick = null;
    this._timer = null;
  }

  /**
   * 是否能录音。
   *
   * 两条路：
   * 1) `global.AthaoNativeRecorder` —— Android APK 里由 Kotlin 的 AudioRecord 采集。
   *    真机实测 WebView 的 getUserMedia 在部分 OEM（vivo OriginOS / Android 16）
   *    上恒定抛 NotReadableError，同机原生 App 录音却正常，故走原生通道绕开。
   * 2) `navigator.mediaDevices.getUserMedia` —— 网页版（桌面与移动浏览器）用这条。
   *
   * 浏览器里不存在 AthaoNativeRecorder，会自动落到 2，**网页版无需任何改动**。
   */
  Recorder.prototype.supported = function () {
    if (global.AthaoNativeRecorder && global.AthaoNativeRecorder.available &&
        global.AthaoNativeRecorder.available()) {
      return true;
    }
    return !!(global.navigator && global.navigator.mediaDevices &&
              global.navigator.mediaDevices.getUserMedia &&
              (global.AudioContext || global.webkitAudioContext));
  };

  Recorder.prototype.useNative = function () {
    return !!(global.AthaoNativeRecorder && global.AthaoNativeRecorder.available &&
              global.AthaoNativeRecorder.available());
  };

  Recorder.prototype.start = function () {
    var self = this;
    if (!this.supported()) {
      return Promise.reject(new Error('unsupported'));
    }

    // ---- 原生录音分支（仅 APK 内可用）----
    if (this.useNative()) {
      return new Promise(function (resolve, reject) {
        var err = global.AthaoNativeRecorder.start();
        if (err) { reject({ code: err, name: 'NativeError' }); return; }
        self._native = true;
        self._nativeStart = Date.now();
        self.chunks = [];
        self.rate = TARGET_RATE;
        // 电平轮询：原生侧不会自动回调，用定时器采样即可（UI 显示够用）
        self._timer = setInterval(function () {
          if (self.onTick) self.onTick();
          if (self.elapsed() > MAX_MS) self.stop();
        }, 100);
        resolve(true);
      });
    }

    // ---- 网页录音分支（网页版走这里）----
    self._native = false;
    return global.navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    }).then(function (stream) {
      self.stream = stream;
      var AC = global.AudioContext || global.webkitAudioContext;
      // 优先直接以 16k 建上下文；不支持则退回默认采样率。
      // 注意：两次构造都必须包 try/catch —— Android WebView 上偶发
      // NotSupportedError("Could not start audio source")，
      // 若兜底那次不包，异常会逃出到 UI 层显示成一句英文原文。
      var ctxErr = null;
      try {
        self.ctx = new AC({ sampleRate: TARGET_RATE });
      } catch (e) {
        try {
          self.ctx = new AC();
        } catch (e2) {
          stream.getTracks().forEach(function (t) { try { t.stop(); } catch (x) {} });
          throw { code: 'audio_context', message: 'audio_context' };
        }
      }
      self.rate = self.ctx.sampleRate || TARGET_RATE;
      self.chunks = [];

      var src = self.ctx.createMediaStreamSource(stream);
      // ScriptProcessor 已废弃但兼容性最好（AudioWorklet 在 file:// 下常被 CORS 拦）
      var proc = self.ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = function (e) {
        var inp = e.inputBuffer.getChannelData(0);
        self.chunks.push(new Float32Array(inp));
        if (self.onLevel) {
          var sum = 0;
          for (var i = 0; i < inp.length; i += 16) sum += inp[i] * inp[i];
          self.onLevel(Math.sqrt(sum / (inp.length / 16)));
        }
      };
      // 必须连到 destination 才会触发 onaudioprocess，
      // 用零增益节点避免把麦克风声音外放
      var mute = self.ctx.createGain();
      mute.gain.value = 0;
      src.connect(proc);
      proc.connect(mute);
      mute.connect(self.ctx.destination);

      self.proc = proc;
      self._timer = setInterval(function () {
        if (self.onTick) self.onTick();
        if (self.elapsed() > MAX_MS) self.stop();
      }, 100);
      return true;
    });
  };

  Recorder.prototype.elapsed = function () {
    // 原生分支：Kotlin 侧拿不到实时字节数，用已流逝的墙钟时间估算，
    // 只用于「到时自动停止」与倒计时显示，精度足够。
    if (this._native) {
      if (!this._nativeStart) return 0;
      return Math.round((Date.now() - this._nativeStart) / 1000 * 1000);
    }
    var total = 0;
    for (var i = 0; i < this.chunks.length; i++) total += this.chunks[i].length;
    return Math.round(total / this.rate * 1000);
  };

  /** @returns {{bytes:Uint8Array, ms:number}|null} 停止并返回 WAV */
  Recorder.prototype.stop = function () {
    // ---- 原生分支：向 Kotlin 要结果，拿到 16k PCM 后照样封装成 WAV ----
    if (this._native) {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      var json = global.AthaoNativeRecorder.poll();
      this._native = false;
      if (!json) return null;
      var r = JSON.parse(json);
      if (!r.ok) return null;
      // Kotlin 侧已按 16000 采集；若设备只支持 44100，这里做一次重采样
      var bytes;
      if (r.rate === TARGET_RATE) {
        bytes = toWav16(base64ToFloat32(r.bytes), TARGET_RATE);
      } else {
        bytes = toWav16(resample(base64ToFloat32(r.bytes), r.rate, TARGET_RATE), TARGET_RATE);
      }
      return { bytes: bytes, ms: wavDurationMs(bytes.length, TARGET_RATE) };
    }

    if (!this.ctx) return null;
    var rate = this.rate;
    var total = 0;
    for (var i = 0; i < this.chunks.length; i++) total += this.chunks[i].length;
    var merged = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < this.chunks.length; j++) {
      merged.set(this.chunks[j], off);
      off += this.chunks[j].length;
    }
    this.cleanup();
    var pcm = rate === TARGET_RATE ? merged : resample(merged, rate, TARGET_RATE);
    var bytes = toWav16(pcm, TARGET_RATE);
    return { bytes: bytes, ms: wavDurationMs(bytes.length, TARGET_RATE) };
  };

  Recorder.prototype.cancel = function () {
    if (this._native) {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this._native = false;
      global.AthaoNativeRecorder.cancel();
      return;
    }
    this.cleanup();
  };

  Recorder.prototype.cleanup = function () {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.proc) { try { this.proc.disconnect(); } catch (e) {} this.proc.onaudioprocess = null; this.proc = null; }
    if (this.stream) {
      var tracks = this.stream.getTracks();
      for (var i = 0; i < tracks.length; i++) tracks[i].stop();
      this.stream = null;
    }
    if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; }
    this.chunks = [];
  };

  // ------------------------------------------------------------ 请求

  /**
   * 提交评测
   * @param {string} text 目标文本
   * @param {Uint8Array} wavBytes 16k/16bit/单声道 WAV
   * @param {number} ms 录音时长
   * @returns {Promise<object>} 服务端归一化结果
   */
  function assess(text, wavBytes, ms) {
    var url = endpoint();
    if (!url) {
      return Promise.reject({ code: 'not_configured',
        message: 'Chưa cấu hình dịch vụ chấm điểm phát âm.' });
    }
    if (ms < MIN_MS) {
      return Promise.reject({ code: 'too_short',
        message: 'Thu âm quá ngắn, hãy đọc to và rõ ràng.' });
    }

    var body = JSON.stringify({
      text: text,
      audio: toBase64(wavBytes),
      sample_rate: TARGET_RATE
    });

    var ctl = null;
    if (global.AbortController) ctl = new global.AbortController();
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 25000);

    var opt = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    };
    if (ctl) opt.signal = ctl.signal;

    // ---- 原生 HTTP 通道（仅 APK 内部有 window.AthaoHttp）----
    // APK 里页面来源是 file://，对 https 的 fetch 属于跨域，
    // 即便服务端配了 CORS 也容易被拦（真机表现为 Failed to fetch）。
    // 这里改由 Kotlin 用 HttpURLConnection 直发，**完全不过浏览器网络栈**，
    // 不存在 CORS。网页版没有这个接口，继续走下面的 fetch。
    if (global.AthaoHttp && global.AthaoHttp.post) {
      return global.AthaoHttp.post(url, body).then(function (t) {
        clearTimeout(timer);
        var j;
        try { j = JSON.parse(t); }
        catch (e) { throw { code: 'bad_response', message: 'Máy chủ trả về dữ liệu lỗi.' }; }
        if (!j.ok) throw { code: j.error || 'error', message: j.hint || j.error || 'Lỗi không xác định.' };
        return j;
      }).catch(function (e) {
        clearTimeout(timer);
        if (e && e.code) throw e;
        throw { code: 'network', message: 'Không kết nối được máy chủ chấm điểm.' };
      });
    }

    return global.fetch(url, opt).then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (t) {
        var j;
        try { j = JSON.parse(t); }
        catch (e) { throw { code: 'bad_response', message: 'Máy chủ trả về dữ liệu lỗi.' }; }
        if (!r.ok && !j.error) throw { code: 'http_' + r.status, message: t.slice(0, 120) };
        if (!j.ok) throw { code: j.error || 'error', message: j.hint || j.error || 'Lỗi không xác định.' };
        return j;
      });
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.code) throw e;
      if (e && e.name === 'AbortError') {
        throw { code: 'timeout', message: 'Yêu cầu quá thời gian, vui lòng thử lại.' };
      }
      throw { code: 'network', message: 'Không kết nối được máy chủ chấm điểm.' };
    });
  }

  // ------------------------------------------------------------ 对外 API

  global.SpeechAssess = {
    TARGET_RATE: TARGET_RATE,
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    MAX_MS: MAX_MS,
    MIN_MS: MIN_MS,
    Recorder: Recorder,
    endpoint: endpoint,
    setEndpoint: setEndpoint,
    resetEndpoint: resetEndpoint,
    configured: configured,
    assess: assess,
    wavDurationMs: wavDurationMs,
    // 内部函数，暴露供回归测试校验（勿在业务代码中直接使用）
    _toWav16: toWav16,
    _resample: resample,
    _toBase64: toBase64
  };
})(window);