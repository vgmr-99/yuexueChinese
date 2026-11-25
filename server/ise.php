<?php
/**
 * ise.php — 讯飞语音评测（ISE）中转服务
 *
 * 为什么必须有这一层
 * ------------------
 *   1. APIKey / APISecret 绝不能进客户端（APK 一反编译就被拿走，额度被盗刷）
 *   2. 浏览器/WebView 有 CORS 限制，且讯飞接口本身不允许浏览器直连
 *   3. 可以集中做限流、鉴权、错误映射、来源白名单
 *
 * 客户端只需 POST：
 *   { "text": "长城", "audio": "<base64 wav>", "sample_rate": 16000 }
 * 返回（已裁剪 + 归一化，两种上游结构统一成同一份）：
 *   { "ok":true,  "score":{...}, "words":[...], "raw_code":0 }
 *   { "ok":false, "error":"...", "hint":"..." }
 *
 * ============================ 安全 ============================
 * 这一层的防护是**必须**的，不是可选的：
 *   - 讯飞评测按次计费。一个没有防护的公开代理 = 任何人都能用你的额度。
 *   - 防护手段（按有效性排序）：
 *       1) `proxy_key`  —— 请求必须带正确的 X-Proxy-Key（推荐）
 *       2) `rate_limit` —— 每 IP 每分钟限流
 *       3) `allowed_origin` —— 来源白名单（注意：Origin 可被非浏览器伪造，
 *          所以它是**辅助**手段，不能替代 1 和 2）
 *   - 三者都可在 config.php 里独立开关。
 *
 * ========================== 上游协议 ==========================
 * 讯飞「语音评测」目前有两套在用的协议，对应 config.php 的 `ise_scheme`：
 *
 *   service_form（默认）
 *     端点   POST https://api.xfyun.cn/v1/service/v1/ise/unicode
 *     请求头 X-Appid / X-CurTime / X-Param / X-CheckSum
 *             X-CheckSum = MD5(apiKey + X-CurTime + X-Param)
 *     请求体 application/x-www-form-urlencoded: audio=..&text=..
 *     结果   data.<category>.rec_paper.<category>
 *
 *   http_cn_json
 *     端点   POST https://api.xfyun.cn/v1/private/http_cn/v1/ise/unicode
 *     请求头 X-Appid / Date / Authorization(HMAC-SHA256) / X-Param
 *     请求体 JSON: {business:{..}, data:{audio,text,..}}
 *     结果   data.result.ws[].cw[]
 *
 * 两种返回结构会被 `normalize_result()` 归一化成同一份 JSON，
 * 客户端不需要区分。
 *
 * 部署：放到 PHP 主机的任意可访问路径（如 /api/ise.php）。
 */

declare(strict_types=1);

const CONFIG_FILE = __DIR__ . '/config.php';

// =================================================================
// 工具
// =================================================================

function send_json(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * 返回错误。
 *
 * 状态码必须正确 —— 之前一律返回 200，客户端只能靠 body 里的 error 字段判断，
 * 监控与限流中间件全都失效。
 */
function fail(string $error, string $hint = '', int $status = 400): void
{
    send_json(['ok' => false, 'error' => $error, 'hint' => $hint], $status);
}

function rfc1123(): string
{
    // 讯飞要求 GMT 格式的 RFC1123：'D, d M Y H:i:s GMT'
    return gmdate('D, d M Y H:i:s') . ' GMT';
}

function uuid4(): string
{
    $d = random_bytes(16);
    $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
    $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
}

/** 当前脚本的完整访问地址，用于在自检页里提示 App 该填什么 */
function self_url(): string
{
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || ((int) ($_SERVER['SERVER_PORT'] ?? 80) === 443);
    $scheme = $https ? 'https' : 'http';
    $host = (string) ($_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost');
    $script = (string) ($_SERVER['SCRIPT_NAME'] ?? '/api/ise.php');
    return $scheme . '://' . $host . $script;
}

// =================================================================
// 鉴权与限流
// =================================================================

/**
 * 校验代理访问口令。
 *
 * 用 hash_equals 做**恒定时间**比较，避免通过响应时间差逐字节爆破。
 */
function check_proxy_key(array $cfg, bool $allow_query = false): bool
{
    $expect = trim((string) ($cfg['proxy_key'] ?? ''));
    if ($expect === '') {
        return true;   // 未配置 → 不要求
    }
    $given = (string) ($_SERVER['HTTP_X_PROXY_KEY'] ?? '');
    if ($given === '' && $allow_query) {
        // 浏览器没法自定义请求头，自检页只能用 ?key= 传
        $given = (string) ($_GET['key'] ?? '');
    }
    if ($given === '') {
        // 某些部署走 POST body 传口令（原生桥更方便）
        $raw = (string) file_get_contents('php://input');
        $in = json_decode($raw, true);
        if (is_array($in) && isset($in['proxy_key'])) {
            $given = (string) $in['proxy_key'];
        }
    }
    return hash_equals($expect, $given);
}

/**
 * 每 IP 限流（文件计数，共享主机可用，不依赖 Redis）。
 *
 * @return array{ok:bool,retry:int}
 */
function rate_limit(array $cfg, string $ip): array
{
    $limit = (int) ($cfg['rate_limit'] ?? 20);
    $window = (int) ($cfg['rate_limit_window'] ?? 60);
    if ($limit <= 0 || $window <= 0) {
        return ['ok' => true, 'retry' => 0];
    }
    $dir = sys_get_temp_dir() . '/vietchinese_ise_rl';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    $file = $dir . '/' . hash('sha256', $ip) . '.json';
    $now = time();
    $hits = [];
    if (is_file($file)) {
        $arr = json_decode((string) @file_get_contents($file), true);
        if (is_array($arr)) {
            $hits = $arr;
        }
    }
    $hits = array_values(array_filter($hits, function ($t) use ($now, $window) {
        return ($now - (int) $t) < $window;
    }));
    if (count($hits) >= $limit) {
        @file_put_contents($file, json_encode($hits));
        return ['ok' => false, 'retry' => $window - ($now - (int) $hits[0])];
    }
    $hits[] = $now;
    @file_put_contents($file, json_encode($hits));
    return ['ok' => true, 'retry' => 0];
}

/** 取客户端 IP。默认只认 REMOTE_ADDR（X-Forwarded-For 可伪造，除非显式信任代理） */
function client_ip(array $cfg): string
{
    if (!empty($cfg['trust_x_forwarded_for'])) {
        $xf = (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
        if ($xf !== '') {
            $first = trim(explode(',', $xf)[0]);
            if ($first !== '') {
                return $first;
            }
        }
    }
    return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
}

// =================================================================
// 讯飞鉴权
// =================================================================

/**
 * 协议 A（service_form）：X-CheckSum = MD5(apiKey + X-CurTime + X-Param)
 *
 * 注意是**直接拼接**，三段之间没有任何分隔符 —— 加了分隔符一定算错。
 */
function sign_checksum(string $api_key, string $cur_time, string $x_param): string
{
    return md5($api_key . $cur_time . $x_param);
}

/**
 * 协议 B（http_cn_json）：HMAC-SHA256 授权串。
 *
 * 规范（讯飞 WebAPI 通用鉴权）：
 *   signature_origin = "host: {host}\ndate: {date}\n{request-line}"
 *   signature        = base64(hmac_sha256(signature_origin, api_secret))
 *   authorization    = base64('api_key="..", algorithm="hmac-sha256",
 *                             headers="host date request-line", signature=".."')
 *
 * 三个易错点（老代码全踩了）：
 *   1. signature_origin **不能**先做 base64 —— 那是给「把参数拼进 URL」的场景用的
 *   2. HMAC 的 key 是 **api_secret**，消息是 signature_origin（不是反过来的）
 *   3. headers 固定写 "host date request-line"，不是 "host date request-id"
 */
function sign_authorization(string $host, string $date, string $request_line,
                            string $api_key, string $api_secret): string
{
    $signature_origin = "host: {$host}\ndate: {$date}\n{$request_line}";
    $signature = base64_encode(
        hash_hmac('sha256', $signature_origin, $api_secret, true)
    );
    $authorization_origin = "api_key=\"{$api_key}\", algorithm=\"hmac-sha256\", "
        . "headers=\"host date request-line\", signature=\"{$signature}\"";
    return base64_encode($authorization_origin);
}

/**
 * 把讯飞的错误码 + desc 翻成人话。
 *
 * 只按错误码映射是不够的：讯飞把「鉴权失败」「参数格式错」「额度用尽」
 * 全都塞在 10105/10106 里，desc 才是真正有信息量的部分
 * （例如 "illegal X-CheckSum" vs "invalid Headprams"）。
 * 这里先看 desc 的关键词，再回落到错误码。
 */
function describe_xfyun_error(int $code, string $desc, string $scheme): string
{
    $d = strtolower($desc);

    // ---- desc 关键词优先 ----
    if (strpos($d, 'illegal x-checksum') !== false) {
        return '讯飞拒绝了签名（illegal X-CheckSum）。请检查 config.php 里的 api_key 是否与'
             . '讯飞控制台一致；X-CurTime 用的是服务器 UTC 时间，还要确认服务器时间没有跑偏。';
    }
    if (strpos($d, 'invalid x-appid') !== false || strpos($d, 'invalid appid') !== false) {
        return '讯飞拒绝了 AppID（invalid X-Appid）。请检查 config.php 里的 app_id。';
    }
    if (strpos($d, 'illegal client_ip') !== false) {
        return '讯飞 IP 白名单拒绝了本服务器的 IP（illegal client_ip）。'
             . '请到讯飞控制台把本服务器公网 IP 加进白名单，或关闭该应用的 IP 白名单。';
    }
    if (strpos($d, 'illegal access') !== false) {
        return '讯飞拒绝访问（illegal access）。常见原因：服务未开通、套餐余量为 0，'
             . '或该 AppID 没有开通语音评测服务。';
    }
    if (strpos($d, 'invalid headprams') !== false || strpos($d, 'invalid headprams') !== false) {
        return '讯飞没有认出请求头（invalid Headprams）。通常是**协议选错了**：'
             . 'config.php 里的 ise_scheme 必须与讯飞账号开通的产品一致。'
             . '当前配置是 ' . $scheme . '。';
    }
    if (strpos($d, 'invalid parameter') !== false) {
        return '讯飞说参数无效（invalid parameter）。请检查 ise_scheme、category、'
             . 'language 是否与讯飞产品匹配，以及音频是否为 16k/16bit/单声道 WAV。';
    }

    // ---- 回落到错误码 ----
    $map = [
        10005 => '参数错误：请检查评测文本与音频格式',
        10105 => '音频过长或格式不符：需 16k/16bit/单声道 WAV',
        10106 => '音频过短或请求头无效：请完整朗读后提交',
        10109 => '音频超过 60 秒',
        10110 => '音频不足 0.5 秒',
        10160 => 'json 解析失败',
        10161 => 'base64 音频解码失败',
        10304 => '评测音频与文本不匹配',
        11200 => '授权次数已用尽，请检查讯飞套餐余量',
        11201 => '当日授权次数已用完',
        11202 => '授权次数不足',
    ];
    $tail = $map[$code] ?? '';
    return sprintf('讯飞返回 %d：%s。%s', $code, $desc, $tail);
}

// =================================================================
// 结果归一化
// =================================================================

/** 安全取浮点数 */
function fnum($v): float
{
    return is_numeric($v) ? (float) $v : 0.0;
}

/**
 * 把讯飞的两种返回结构归一化成同一份。
 *
 * 新版（中文版/流式版）：data.result.ws[].cw[]
 *   score: overall_score / phone_score / tone_score / pron_coi / flu_score
 *
 * 旧版（普通版）：data.<category>.rec_paper.<category>
 *   score: total_score / phone_score / tone_score / integrity_score / fluency_score
 *
 * @return array{score:array,words:array,rejected:bool}
 */
function normalize_result(array $json): array
{
    $data = $json['data'] ?? [];

    // ---------- 新版结构 ----------
    if (isset($data['result']['ws']) && is_array($data['result']['ws'])) {
        $result = $data['result'];
        $words = [];
        foreach ($result['ws'] as $w) {
            $chars = [];
            foreach (($w['cw'] ?? []) as $cw) {
                $chars[] = [
                    'w'  => (string) ($cw['w'] ?? ''),
                    'sc' => round(fnum($cw['sc'] ?? 0), 1),
                ];
            }
            if (!$chars) {
                continue;
            }
            $avg = 0.0;
            foreach ($chars as $c) {
                $avg += $c['sc'];
            }
            $words[] = [
                'chars' => $chars,
                'sc'    => round($avg / count($chars), 1),
                'bg'    => (int) ($w['bg'] ?? 0),
                'ed'    => (int) ($w['ed'] ?? 0),
                'ri'    => (int) ($w['ri'] ?? 0),
                'type'  => (string) ($w['type'] ?? ''),
                'rl'    => (int) ($w['rl'] ?? 0),
            ];
        }
        return [
            'score' => [
                'overall' => round(fnum($result['overall_score'] ?? 0), 1),
                'phone'   => round(fnum($result['phone_score'] ?? 0), 1),
                'tone'    => round(fnum($result['tone_score'] ?? 0), 1),
                'pron'    => round(fnum($result['pron_coi'] ?? 0), 1),
                'fluency' => round(fnum($result['flu_score'] ?? 0), 1),
            ],
            'words'    => $words,
            'rejected' => false,
        ];
    }

    // ---------- 旧版结构 ----------
    foreach (['read_syllable', 'read_word', 'read_sentence', 'read_chapter'] as $cat) {
        if (!isset($data[$cat]) || !is_array($data[$cat])) {
            continue;
        }
        $root = $data[$cat]['rec_paper'][$cat] ?? [];
        if (!is_array($root)) {
            $root = [];
        }

        // 旧版的评分字段名和网页端期望的不一致，这里统一
        $overall = fnum($root['total_score'] ?? 0);
        $phone   = fnum($root['phone_score'] ?? 0);
        $tone    = fnum($root['tone_score'] ?? 0);
        $fluency = fnum($root['fluency_score'] ?? 0);
        $integrity = fnum($root['integrity_score'] ?? 0);
        // 旧版没有「连读分」，用完整度补位，避免页面出现一个恒为 0 的分项
        $pron = $integrity > 0 ? $integrity : fnum($root['pron_coi'] ?? 0);

        $units = [];
        if (isset($root['word']) && is_array($root['word'])) {
            $units = $root['word'];
        } elseif (isset($root['sentence']) && is_array($root['sentence'])) {
            // 句子题型：展平每个句子里的词
            foreach ($root['sentence'] as $sent) {
                if (isset($sent['word']) && is_array($sent['word'])) {
                    foreach ($sent['word'] as $u) {
                        $units[] = $u;
                    }
                } elseif (isset($sent['content'])) {
                    $units[] = $sent;
                }
            }
        }

        $words = [];
        foreach ($units as $u) {
            $chars = [];
            if (isset($u['word']) && is_array($u['word'])) {
                foreach ($u['word'] as $cw) {
                    $chars[] = [
                        'w'  => (string) ($cw['content'] ?? ''),
                        'sc' => round(fnum($cw['total_score'] ?? 0), 1),
                    ];
                }
            } else {
                $chars[] = [
                    'w'  => (string) ($u['content'] ?? ''),
                    'sc' => round(fnum($u['total_score'] ?? $overall), 1),
                ];
            }
            if (!$chars) {
                continue;
            }
            $avg = 0.0;
            foreach ($chars as $c) {
                $avg += $c['sc'];
            }
            $words[] = [
                'chars' => $chars,
                'sc'    => round($avg / count($chars), 1),
                'bg'    => (int) ($u['begin_pos'] ?? 0),
                'ed'    => (int) ($u['end_pos'] ?? 0),
                'ri'    => 0,
                'type'  => '',
                'rl'    => 0,
            ];
        }

        return [
            'score' => [
                'overall' => round($overall, 1),
                'phone'   => round($phone, 1),
                'tone'    => round($tone, 1),
                'pron'    => round($pron, 1),
                'fluency' => round($fluency, 1),
            ],
            'words'    => $words,
            'rejected' => (string) ($root['is_rejected'] ?? '') === 'true',
        ];
    }

    // 认不出来的结构：给一个空的、但结构合法的结果，避免客户端拿到 undefined
    return [
        'score' => [
            'overall' => 0.0, 'phone' => 0.0, 'tone' => 0.0,
            'pron' => 0.0, 'fluency' => 0.0,
        ],
        'words'    => [],
        'rejected' => false,
    ];
}

// =================================================================
// 自检页面
// =================================================================

/**
 * 用浏览器直接打开本文件（GET）时，返回一个可视化自检页：
 * 显示 PHP 版本、cURL 可用性、凭证是否已填、防护配置、讯飞主机，
 * 并可一键测试连通性（ping 不消耗评测额度）。
 */
function render_status_page(array $state): void
{
    header('Content-Type: text/html; charset=utf-8');
    $ok   = (bool) $state['configured'];
    $php  = htmlspecialchars((string) $state['php_version']);
    $cur  = $state['has_curl'] ? '可用' : '缺失（无法转发讯飞，请联系主机商开启 cURL 扩展）';
    $id   = htmlspecialchars((string) $state['app_id_masked']);
    $host = htmlspecialchars((string) $state['ise_host']);
    $cat  = htmlspecialchars((string) $state['category']);
    $lang = htmlspecialchars((string) $state['language']);
    $dwa  = htmlspecialchars((string) $state['dwa']);
    $scheme = htmlspecialchars((string) $state['scheme']);
    $guard  = htmlspecialchars((string) $state['guard']);
    $cfgMsg = $ok
        ? '<span class="ok">已读取到凭证</span>'
        : '<span class="bad">未配置：请打开 <code>config.php</code> 填入 AppID / APIKey / APISecret</span>';
    $endpoint = htmlspecialchars((string) $state['endpoint']);

    echo <<<HTML
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>越学中文 发音评测服务 · 自检</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:680px;margin:32px auto;
      padding:0 16px;line-height:1.75;color:#1f2937;background:#f8fafc}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:#6b7280;font-size:13px;margin-bottom:18px}
 table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;
       box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}
 td{padding:9px 13px;border-bottom:1px solid #eef2f6;font-size:14px}
 td:first-child{color:#6b7280;width:38%}
 code{background:#eef2f6;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
 .ok{color:#059669;font-weight:600}
 .bad{color:#dc2626;font-weight:600}
 button{background:#0f766e;color:#fff;border:0;padding:11px 20px;border-radius:9px;
        font-size:15px;cursor:pointer;font-family:inherit}
 button:disabled{opacity:.55;cursor:wait}
 #out{margin-top:14px;padding:12px;background:#fff;border-radius:10px;font-size:13px;
      font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all;
      box-shadow:0 1px 3px rgba(0,0,0,.08)}
 .tip{background:#eff6ff;border-left:3px solid #3b82f6;padding:10px 13px;border-radius:6px;
      font-size:13.5px;color:#1e40af}
 .warn{background:#fff7ed;border-left:3px solid #ea580c;padding:10px 13px;border-radius:6px;
      font-size:13.5px;color:#9a3412}
</style></head><body>
<h1>越学中文 发音评测服务 · 自检</h1>
<div class="sub">讯飞 ISE 中转服务状态面板</div>

<table>
 <tr><td>PHP 版本</td><td>{$php}</td></tr>
 <tr><td>cURL 扩展</td><td>{$cur}</td></tr>
 <tr><td>讯飞凭证</td><td>{$cfgMsg}</td></tr>
 <tr><td>AppID</td><td><code>{$id}</code></td></tr>
 <tr><td>上游协议</td><td><code>{$scheme}</code></td></tr>
 <tr><td>讯飞接口</td><td><code>{$host}</code></td></tr>
 <tr><td>题型 / 语言 / 音素</td><td>{$cat} · {$lang} · {$dwa}</td></tr>
 <tr><td>访问防护</td><td>{$guard}</td></tr>
</table>

<button id="btn">测试与讯飞的连通性</button>
<div id="out">点击上方按钮自检（不会消耗评测额度）。</div>

<p class="tip"><b>在 App 里填写这个地址：</b><br><code>{$endpoint}</code></p>

<script>
document.getElementById('btn').addEventListener('click', function () {
  var b = this, o = document.getElementById('out');
  b.disabled = true; o.textContent = '正在请求…';
  fetch(window.location.href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ping' })
  }).then(function (r) { return r.text(); })
    .then(function (t) { o.textContent = t; b.disabled = false; })
    .catch(function (e) { o.textContent = '请求失败：' + e; b.disabled = false; });
});
</script>
</body></html>
HTML;
    exit;
}

// =================================================================
// CORS
// =================================================================

$cfg = [];
$origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');

header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Proxy-Key');
header('Access-Control-Max-Age: 86400');
header('Vary: Origin');

// =================================================================
// 配置加载
// =================================================================

$is_get = ($_SERVER['REQUEST_METHOD'] === 'GET');

if (!file_exists(CONFIG_FILE)) {
    if ($is_get) {
        render_status_page([
            'configured' => false, 'php_version' => PHP_VERSION,
            'has_curl' => function_exists('curl_init'),
            'app_id_masked' => '-', 'ise_host' => '-',
            'category' => '-', 'language' => '-', 'dwa' => '-',
            'scheme' => '-', 'guard' => '-',
            'endpoint' => self_url(),
        ]);
    }
    fail('server_not_configured',
        '缺少 config.php：请复制 config.example.php 并填入讯飞 AppID/APIKey/APISecret。',
        500);
    return;
}
$cfg = (array) (require CONFIG_FILE);

// ---------------------------------------------------------------- 防护 0：代理口令（先于一切业务逻辑）
//
// GET（自检页）允许用 ?key= 传口令，因为浏览器没法自定义请求头；
// POST 一律走 X-Proxy-Key 请求头或 body 里的 proxy_key 字段。

if (!check_proxy_key($cfg, $is_get)) {
    fail('proxy_key_invalid',
        '代理访问口令不正确。客户端请求需带 X-Proxy-Key 请求头；'
        . '浏览器打开自检页请用 ?key=你的口令。', 401);
    return;
}

// ---------------------------------------------------------------- 来源白名单（辅助手段，不是安全边界）

$allowed = trim((string) ($cfg['allowed_origin'] ?? ''));
if ($allowed !== '') {
    header("Access-Control-Allow-Origin: {$allowed}");
    if ($origin !== '' && $origin !== $allowed) {
        fail('origin_not_allowed', '来源不在白名单内。', 403);
        return;
    }
} else {
    header('Access-Control-Allow-Origin: *');
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$missing = [];
foreach (['app_id', 'api_key', 'api_secret'] as $k) {
    if (empty($cfg[$k]) || strpos((string) $cfg[$k], 'YOUR_') === 0) {
        $missing[] = $k;
    }
}

$scheme = (string) ($cfg['ise_scheme'] ?? 'service_form');
$iseUrl = (string) ($cfg['ise_url']
    ?? ($scheme === 'service_form'
        ? 'https://api.xfyun.cn/v1/service/v1/ise/unicode'
        : 'https://api.xfyun.cn/v1/private/http_cn/v1/ise/unicode'));

if ($is_get) {
    $guardParts = [];
    $guardParts[] = !empty($cfg['proxy_key']) ? '代理口令' : '无代理口令';
    $guardParts[] = '限流 ' . (int) ($cfg['rate_limit'] ?? 20)
        . '/' . (int) ($cfg['rate_limit_window'] ?? 60) . 's';
    $guardParts[] = $allowed !== '' ? '来源白名单' : '无来源白名单';

    render_status_page([
        'configured'    => empty($missing),
        'php_version'   => PHP_VERSION,
        'has_curl'      => function_exists('curl_init'),
        'app_id_masked' => empty($cfg['app_id']) ? '-' : substr((string) $cfg['app_id'], 0, 4) . '****',
        'ise_host'      => (string) (parse_url($iseUrl, PHP_URL_HOST) ?: 'api.xfyun.cn'),
        'category'      => (string) ($cfg['category'] ?? 'read_sentence'),
        'language'      => (string) ($cfg['language'] ?? 'zh_cn'),
        'dwa'           => (string) ($cfg['dwa'] ?? 'wpgs'),
        'scheme'        => $scheme,
        'guard'         => implode(' · ', $guardParts),
        'endpoint'      => self_url(),
    ]);
    return;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail('method_not_allowed', '请用 POST。', 405);
    return;
}

if (!empty($missing)) {
    fail('server_not_configured',
        'config.php 中未填写：' . implode('、', $missing) . '。', 500);
    return;
}

if (!function_exists('curl_init')) {
    fail('curl_missing', '服务器缺少 cURL 扩展，无法转发到讯飞。', 500);
    return;
}

// ---------------------------------------------------------------- 入参校验

$raw = file_get_contents('php://input');
if ($raw === false || $raw === '') {
    fail('empty_body', '请求体为空。');
    return;
}
if (strlen($raw) > 12 * 1024 * 1024) {
    fail('payload_too_large', '音频过大（上限约 12MB），请缩短录音。', 413);
    return;
}

$in = json_decode($raw, true);
if (!is_array($in)) {
    fail('bad_json', '请求体不是合法 JSON。');
    return;
}

/**
 * 自检模式：只回报配置状态与连通性，**不调用讯飞、不消耗额度**。
 * 用法：curl -X POST -d '{"action":"ping"}' https://你的域名/api/ise.php
 *
 * 注意：ping **不计入限流配额** —— 它是部署后的例行自检，
 * 不应该因为点了几次自检就把正常用户的评测额度挤掉。
 */
if (($in['action'] ?? '') === 'ping') {
    send_json([
        'ok' => true,
        'ping' => true,
        'php_version' => PHP_VERSION,
        'has_curl' => function_exists('curl_init'),
        'app_id_masked' => substr((string) $cfg['app_id'], 0, 4) . '****',
        'ise_host' => (string) (parse_url($iseUrl, PHP_URL_HOST) ?: 'api.xfyun.cn'),
        'ise_scheme' => $scheme,
        'category' => (string) ($cfg['category'] ?? 'read_sentence'),
        'language' => (string) ($cfg['language'] ?? 'zh_cn'),
        'dwa' => (string) ($cfg['dwa'] ?? 'wpgs'),
        'note' => '配置已读取。发送真实评测请求即会调用讯飞并消耗额度。',
    ]);
    return;
}

// ---------------------------------------------------------------- 限流（只对真实评测计数）

$rl = rate_limit($cfg, client_ip($cfg));
if (!$rl['ok']) {
    header('Retry-After: ' . max(1, (int) $rl['retry']));
    fail('rate_limited', '请求过于频繁，请稍后再试。', 429);
    return;
}

$text = trim((string) ($in['text'] ?? ''));
$audio = trim((string) ($in['audio'] ?? ''));

if ($text === '') {
    fail('missing_text', '缺少 text（要评测的目标文本）。');
    return;
}
// 讯飞限制：中文不超过 180 字节
if (strlen($text) > 600) {
    fail('text_too_long', '评测文本过长（中文不超过 180 字节）。');
    return;
}
if ($audio === '') {
    fail('missing_audio', '缺少 audio（base64 编码的 16k/16bit/单声道 WAV）。');
    return;
}
if (!preg_match('#^[A-Za-z0-9+/=]+$#', $audio)) {
    fail('bad_audio', 'audio 必须是纯 base64。');
    return;
}
// 讯飞限制：base64 后不超过 5MB
if (strlen($audio) > 5 * 1024 * 1024) {
    fail('audio_too_large', '音频过大（base64 后上限 5MB），请缩短录音。', 413);
    return;
}

$sampleRate = (int) ($in['sample_rate'] ?? 16000);
if ($sampleRate !== 16000) {
    $sampleRate = 16000; // 讯飞要求 16k
}

// ---------------------------------------------------------------- 组装上游请求

$category = (string) ($cfg['category'] ?? 'read_sentence');
$language = (string) ($cfg['language'] ?? 'zh_cn');
$dwa      = (string) ($cfg['dwa'] ?? 'wpgs');
// 部分接口要求试题带前缀，默认空；如遇 10005 参数错误可改成 '[content]'
$textPrefix = (string) ($cfg['text_prefix'] ?? '');

if ($scheme === 'service_form') {
    // ---------------- 协议 A：MD5 X-CheckSum + 表单请求体 ----------------
    $business = [
        'aue'          => 'raw',        // 裸 PCM/WAV
        'result_level' => (string) ($cfg['result_level'] ?? 'simple'),
        'language'     => $language,
        'category'     => $category,
    ];
    if (!empty($cfg['extra_ability'])) {
        $business['extra_ability'] = (string) $cfg['extra_ability'];
    }
    $xParam = base64_encode(json_encode($business, JSON_UNESCAPED_UNICODE));
    $curTime = (string) time();

    $headers = [
        'X-Appid: ' . $cfg['app_id'],
        'X-CurTime: ' . $curTime,
        'X-Param: ' . $xParam,
        'X-CheckSum: ' . sign_checksum((string) $cfg['api_key'], $curTime, $xParam),
        'Content-Type: application/x-www-form-urlencoded; charset=utf-8',
    ];
    // 表单体：audio 需 base64 后再 urlencode；http_build_query 会做一次 urlencode
    $postBody = http_build_query([
        'audio' => $audio,
        'text'  => $textPrefix . $text,
    ], '', '&', PHP_QUERY_RFC1738);
} else {
    // ---------------- 协议 B：HMAC-SHA256 Authorization + JSON 请求体 ----------------
    $uriPath = (string) parse_url($iseUrl, PHP_URL_PATH);
    $host    = (string) parse_url($iseUrl, PHP_URL_HOST);
    $date    = rfc1123();
    $requestLine = 'POST ' . $uriPath . ' HTTP/1.1';

    $param = [
        'business' => [
            'language'     => $language,
            'category'     => $category,
            'dwa'          => $dwa,
            'vad_eos'      => (string) ($cfg['vad_eos'] ?? '10000'),
            'ptype'        => 'upload',
            'rlang'        => 'zh-cn',
            'wdec'         => '0',
            'multi_speech' => '1',
        ],
        'data' => [
            'aue'         => 'raw',
            'sample_rate' => (string) $sampleRate,
            'status'      => '2',          // 一次性上传整段
            'audio'       => $audio,
            'text'        => $textPrefix . $text,
        ],
    ];
    $bodyJson = json_encode($param, JSON_UNESCAPED_UNICODE);

    // X-Param 里**不放音频**。
    // 音频 base64 后动辄几百 KB，塞进 HTTP 头会被主机/网关直接拒收
    // （nginx 默认单个 header 上限约 8KB）。音频走请求体。
    $paramForHeader = $param;
    unset($paramForHeader['data']['audio']);

    $headers = [
        'X-Appid: ' . $cfg['app_id'],
        'Date: ' . $date,
        'X-Param: ' . base64_encode(json_encode($paramForHeader, JSON_UNESCAPED_UNICODE)),
        'Authorization: ' . sign_authorization(
            $host, $date, $requestLine,
            (string) $cfg['api_key'], (string) $cfg['api_secret']
        ),
        'Content-Type: application/json',
    ];
    $postBody = $bodyJson;
}

// ---------------------------------------------------------------- 调讯飞

$ch = curl_init($iseUrl);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $postBody,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 30,
    CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_HTTPHEADER     => $headers,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
]);

$resp = curl_exec($ch);
$http = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err  = curl_error($ch);
curl_close($ch);

if ($resp === false) {
    fail('upstream_unreachable', $err ?: '无法连接讯飞服务器，请稍后再试。', 502);
    return;
}

$json = json_decode((string) $resp, true);
if (!is_array($json)) {
    fail('upstream_bad_response', "HTTP {$http}：" . substr((string) $resp, 0, 200), 502);
    return;
}

$code = (int) ($json['code'] ?? -1);
if ($code !== 0) {
    $desc = (string) ($json['desc'] ?? '未知错误');
    fail('xfyun_error', describe_xfyun_error($code, $desc, $scheme), 502);
    return;
}

// ---------------------------------------------------------------- 归一化输出

$norm = normalize_result($json);

send_json([
    'ok'        => true,
    'raw_code'  => 0,
    'score'     => $norm['score'],
    'words'     => $norm['words'],
    'rejected'  => $norm['rejected'],
    'sid'       => (string) ($json['sid'] ?? ($json['data']['sid'] ?? '')),
    'scheme'    => $scheme,
]);
