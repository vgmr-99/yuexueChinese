<?php
/**
 * ise.php — 讯飞语音评测（ISE WebAPI）服务端代理
 *
 * 为什么必须有这一层：
 *   1. APIKey / APISecret 绝不能进客户端（APK 里一反编译就被拿走，额度被盗刷）
 *   2. 浏览器/WebView 有 CORS 限制，直连 api.xfyun.cn 会被拦
 *   3. 可以集中做限流、错误映射、白名单
 *
 * 客户端只需 POST：
 *   { "text": "长城", "audio": "<base64 wav>", "sample_rate": 16000 }
 *
 * 返回（已裁剪 + 归一化）：
 *   { "ok":true, "score":{...}, "words":[...], "raw_code":0 }
 *   { "ok":false, "error":"...", "hint":"..." }
 *
 * 部署：放到 PHP 主机的任意可访问路径（如 /api/ise.php）。
 */

declare(strict_types=1);

const CONFIG_FILE = __DIR__ . '/config.php';

// ---------------------------------------------------------------- 工具

function send_json(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $error, string $hint = '', int $status = 200): void
{
    send_json(['ok' => false, 'error' => $error, 'hint' => $hint], $status);
}

/** 讯飞 WebAPI 鉴权签名 */
function ise_sign(string $host, string $date, string $request_id, string $path,
                  string $method, string $api_key, string $api_secret): string
{
    $signature_origin = "host: {$host}\ndate: {$date}\nrequest-id: {$request_id}\n{$method} {$path} HTTP/1.1";
    $signature_origin = base64_encode($signature_origin);

    $hmac_key = hash_hmac('sha256', $date, $api_key, true);
    $signature = base64_encode(hash_hmac('sha256', $signature_origin, $hmac_key, true));

    $authorization_origin = "api_key=\"{$api_key}\", algorithm=\"hmac-sha256\", "
        . "headers=\"host date request-id\", signature=\"{$signature}\"";

    return base64_encode($authorization_origin);
}

function rfc1123(): string
{
    // 讯飞要求 GMT 格式的 RFC1123
    return gmdate('D, d M Y H:i:s') . ' GMT';
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

function uuid4(): string
{
    $d = random_bytes(16);
    $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
    $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
}

// ---------------------------------------------------------------- CORS

$cfg = [];
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Max-Age: 86400');
header('Vary: Origin');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    // 预检
    if (file_exists(CONFIG_FILE)) {
        $cfg = (array) (require CONFIG_FILE);
    }
    $allowed = $cfg['allowed_origin'] ?? '';
    if ($allowed && $origin === $allowed) {
        header("Access-Control-Allow-Origin: {$allowed}");
    } else {
        header('Access-Control-Allow-Origin: *');
    }
    http_response_code(204);
    exit;
}

// ---------------------------------------------------------------- 配置

// ---------------------------------------------------------------- 自检页面
//
// 用浏览器直接打开本文件（GET）时，返回一个可视化自检页：
// 显示 PHP 版本、cURL 可用性、凭证是否已填、讯飞主机，并可一键测试连通性。
// 这样部署者不需要敲 curl 命令——网页本身就能发 POST。
//
// 注意：App 走的是 POST JSON 接口，两者互不影响。

function render_status_page(array $state): void
{
    header('Content-Type: text/html; charset=utf-8');
    $ok  = (bool) $state['configured'];
    $php = htmlspecialchars((string) $state['php_version']);
    $cur = $state['has_curl'] ? '✅ 可用' : '❌ 缺失（无法转发讯飞，请联系主机商开启 cURL 扩展）';
    $id  = htmlspecialchars((string) $state['app_id_masked']);
    $host= htmlspecialchars((string) $state['ise_host']);
    $cat = htmlspecialchars((string) $state['category']);
    $lang= htmlspecialchars((string) $state['language']);
    $dwa = htmlspecialchars((string) $state['dwa']);
    $cfgMsg = $ok
        ? '<span class="ok">已读取到凭证</span>'
        : '<span class="bad">未配置：请打开 <code>config.php</code> 填入 AppID / APIKey / APISecret</span>';
    $endpoint = htmlspecialchars((string) $state['endpoint']);

    echo <<<HTML
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Athao 发音评测服务 · 自检</title>
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
</style></head><body>
<h1>🔊 Athao 发音评测服务 · 自检</h1>
<div class="sub">讯飞 ISE 中转服务状态面板</div>

<table>
 <tr><td>PHP 版本</td><td>{$php}</td></tr>
 <tr><td>cURL 扩展</td><td>{$cur}</td></tr>
 <tr><td>讯飞凭证</td><td>{$cfgMsg}</td></tr>
 <tr><td>AppID</td><td><code>{$id}</code></td></tr>
 <tr><td>讯飞接口</td><td><code>{$host}</code></td></tr>
 <tr><td>评测等级 / 语言</td><td>{$cat} · {$lang} · {$dwa}</td></tr>
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

// ---------------------------------------------------------------- 配置

$is_get = ($_SERVER['REQUEST_METHOD'] === 'GET');

if (!file_exists(CONFIG_FILE)) {
    if ($is_get) {
        render_status_page([
            'configured' => false, 'php_version' => PHP_VERSION,
            'has_curl' => function_exists('curl_init'),
            'app_id_masked' => '-', 'ise_host' => 'api.xfyun.cn',
            'category' => '-', 'language' => '-', 'dwa' => '-',
            'endpoint' => self_url(),
        ]);
    }
    fail('server_not_configured',
        '缺少 config.php：请复制 config.example.php 并填入讯飞 AppID/APIKey/APISecret。');
    return;
}
$cfg = (array) (require CONFIG_FILE);

$allowed = trim((string) ($cfg['allowed_origin'] ?? ''));
if ($allowed) {
    header("Access-Control-Allow-Origin: {$allowed}");
    if ($origin && $origin !== $allowed) {
        fail('origin_not_allowed', '来源不在白名单内。');
        return;
    }
} else {
    header('Access-Control-Allow-Origin: *');
}

$missing = [];
foreach (['app_id', 'api_key', 'api_secret'] as $k) {
    if (empty($cfg[$k]) || strpos((string) $cfg[$k], 'YOUR_') === 0) {
        $missing[] = $k;
    }
}

if ($is_get) {
    render_status_page([
        'configured'    => empty($missing),
        'php_version'   => PHP_VERSION,
        'has_curl'      => function_exists('curl_init'),
        'app_id_masked' => empty($cfg['app_id']) ? '-' : substr((string) $cfg['app_id'], 0, 4) . '****',
        'ise_host'      => (string) (parse_url((string) ($cfg['ise_url'] ?? ''), PHP_URL_HOST) ?: 'api.xfyun.cn'),
        'category'      => (string) ($cfg['category'] ?? 'lv1'),
        'language'      => (string) ($cfg['language'] ?? 'zh_cn'),
        'dwa'           => (string) ($cfg['dwa'] ?? 'wpgs'),
        'endpoint'      => self_url(),
    ]);
    return;
}

if (!empty($missing)) {
    fail('server_not_configured', 'config.php 中未填写：' . implode('、', $missing) . '。');
    return;
}

// ---------------------------------------------------------------- 入参校验

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail('method_not_allowed', '请用 POST。');
    return;
}

$raw = file_get_contents('php://input');
if ($raw === false || $raw === '') {
    fail('empty_body', '请求体为空。');
    return;
}
if (strlen($raw) > 12 * 1024 * 1024) {
    fail('payload_too_large', '音频过大（上限约 12MB），请缩短录音。');
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
 * 部署完成后先用它确认「PHP 能跑、凭证读到了、域名/路径对」，
 * 再去 App 里试真正的评测。
 */
if (($in['action'] ?? '') === 'ping') {
    send_json([
        'ok' => true,
        'ping' => true,
        'php_version' => PHP_VERSION,
        'has_curl' => function_exists('curl_init'),
        'app_id_masked' => substr((string) $cfg['app_id'], 0, 4) . '****',
        'ise_host' => (string) (parse_url((string) $cfg['ise_url'], PHP_URL_HOST) ?: 'api.xfyun.cn'),
        'category' => (string) ($cfg['category'] ?? 'lv1'),
        'language'  => (string) ($cfg['language'] ?? 'zh_cn'),
        'dwa'       => (string) ($cfg['dwa'] ?? 'wpgs'),
        'note' => '配置已读取。发送真实评测请求即会调用讯飞。',
    ]);
    return;
}

$text = trim((string) ($in['text'] ?? ''));
$audio = trim((string) ($in['audio'] ?? ''));

if ($text === '') {
    fail('missing_text', '缺少 text（要评测的目标文本）。');
    return;
}
if (mb_strlen($text, 'UTF-8') > 200) {
    fail('text_too_long', '评测文本过长（≤200 字）。');
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

$sampleRate = (int) ($in['sample_rate'] ?? 16000);
if ($sampleRate !== 16000) {
    $sampleRate = 16000; // 讯飞要求 16k
}

// ---------------------------------------------------------------- 调讯飞

$iseUrl  = (string) ($cfg['ise_url'] ?? 'https://api.xfyun.cn/v1/private/http_cn/v1/ise/unicode');
$uriPath = (string) parse_url($iseUrl, PHP_URL_PATH);
$host    = (string) parse_url($iseUrl, PHP_URL_HOST);

$date       = rfc1123();
$requestId  = uuid4();
$signature  = ise_sign($host, $date, $requestId, $uriPath, 'POST',
                        (string) $cfg['api_key'], (string) $cfg['api_secret']);

$param = [
    'business' => [
        'language'    => (string) ($cfg['language'] ?? 'zh_cn'),
        'category'    => (string) ($cfg['category'] ?? 'lv1'),
        'dwa'         => (string) ($cfg['dwa'] ?? 'wpgs'),
        'vad_eos'     => (string) ($cfg['vad_eos'] ?? '10000'),
        'ptype'       => 'upload',
        'rlang'       => 'zh-cn',
        'wdec'        => '0',
        'multi_speech' => '1',
    ],
    'data' => [
        'aue'         => 'raw',           // 输入音频为裸 WAV
        'sample_rate' => (string) $sampleRate,
        'status'      => '2',             // 一次性上传整段
        'audio'       => $audio,
        'text'        => $text,
    ],
];

$headers = [
    'X-Appid: ' . $cfg['app_id'],
    'X-CurTime: ' . time(),
    'X-Param: ' . base64_encode(json_encode($param, JSON_UNESCAPED_UNICODE)),
    'Authorization: ' . $signature,
    'Content-Type: application/json',
];

$ch = curl_init($iseUrl);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => json_encode($param, JSON_UNESCAPED_UNICODE),
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
    fail('upstream_unreachable', $err ?: '无法连接讯飞服务器，请稍后再试。');
    return;
}

$json = json_decode((string) $resp, true);
if (!is_array($json)) {
    fail('upstream_bad_response', "HTTP {$http}：" . substr((string) $resp, 0, 200));
    return;
}

$code = (int) ($json['code'] ?? -1);
if ($code !== 0) {
    // 讯飞错误码 → 人话
    $map = [
        10005 => '参数错误：请检查评测文本与音频格式',
        10105 => '音频过长或格式不符：需 16k/16bit/单声道 WAV',
        10106 => '音频过短：请完整朗读后提交',
        10109 => '音频超过 60 秒',
        10110 => '音频不足 0.5 秒',
        10160 => 'json 解析失败',
        10161 => 'base64 音频解码失败',
        10304 => '评测音频与文本不匹配',
        11200 => '授权次数已用尽，请检查讯飞套餐余量',
        11201 => '当日授权次数已用完',
        11202 => '授权次数不足',
    ];
    $desc = $json['desc'] ?? '未知错误';
    fail('xfyun_error', sprintf('讯飞返回 %d：%s。%s',
        $code, $desc, $map[$code] ?? ''));
    return;
}

// ---------------------------------------------------------------- 归一化输出

$data   = $json['data'] ?? [];
$result = $data['result'] ?? [];

$words = [];
foreach (($result['ws'] ?? []) as $w) {
    $chars = [];
    foreach (($w['cw'] ?? []) as $cw) {
        $chars[] = [
            'w'  => (string) ($cw['w'] ?? ''),
            'sc' => round((float) ($cw['sc'] ?? 0), 1),
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
        'chars'   => $chars,
        'sc'      => round($avg / count($chars), 1),
        'bg'      => (int) ($w['bg'] ?? 0),
        'ed'      => (int) ($w['ed'] ?? 0),
        // 音素信息（dwa=wpgs 时才有）
        'ri'      => (int) ($w['ri'] ?? 0),
        'type'    => (string) ($w['type'] ?? ''),
        'rl'      => (int) ($w['rl'] ?? 0),
    ];
}

send_json([
    'ok'        => true,
    'raw_code'  => 0,
    'score'     => [
        'overall' => round((float) ($result['overall_score'] ?? 0), 1),
        'phone'   => round((float) ($result['phone_score'] ?? 0), 1),   // 声韵母
        'tone'    => round((float) ($result['tone_score'] ?? 0), 1),    // 声调
        'pron'    => round((float) ($result['pron_coi'] ?? 0), 1),      // 连读
        'fluency' => round((float) ($result['flu_score'] ?? 0), 1),     // 流利度
    ],
    'words'     => $words,
    'sid'       => (string) ($data['sid'] ?? ''),
    'audio_url' => (string) ($result['replays'] ?? ($result['audio_url'] ?? '')),
]);