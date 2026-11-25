<?php
/**
 * selftest.php — 中转服务自检脚本
 *
 * 部署后先跑这个，确认：
 *   1. PHP 环境正常
 *   2. **鉴权算法正确**（用固定向量比对，改错了会立刻红）
 *   3. **结果归一化正确**（两种讯飞返回结构都能解析出分数）
 *
 * 用法：
 *   php selftest.php
 * 或浏览器打开：https://你的域名/api/selftest.php
 *
 * 这个文件不依赖 config.php，可以单独拷出来跑。
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '1');

// =================================================================
// 被测函数（与 ise.php 保持一致；改一处必须同步改另一处）
// =================================================================

function sign_checksum(string $api_key, string $cur_time, string $x_param): string
{
    return md5($api_key . $cur_time . $x_param);
}

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

function fnum($v): float
{
    return is_numeric($v) ? (float) $v : 0.0;
}

function describe_xfyun_error(int $code, string $desc, string $scheme): string
{
    $d = strtolower($desc);
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

function normalize_result(array $json): array
{
    $data = $json['data'] ?? [];

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

    foreach (['read_syllable', 'read_word', 'read_sentence', 'read_chapter'] as $cat) {
        if (!isset($data[$cat]) || !is_array($data[$cat])) {
            continue;
        }
        $root = $data[$cat]['rec_paper'][$cat] ?? [];
        if (!is_array($root)) {
            $root = [];
        }
        $overall   = fnum($root['total_score'] ?? 0);
        $phone     = fnum($root['phone_score'] ?? 0);
        $tone      = fnum($root['tone_score'] ?? 0);
        $fluency   = fnum($root['fluency_score'] ?? 0);
        $integrity = fnum($root['integrity_score'] ?? 0);
        $pron = $integrity > 0 ? $integrity : fnum($root['pron_coi'] ?? 0);

        $units = [];
        if (isset($root['word']) && is_array($root['word'])) {
            $units = $root['word'];
        } elseif (isset($root['sentence']) && is_array($root['sentence'])) {
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
// 断言
// =================================================================

$pass = 0;
$fail = 0;

function check(string $name, $actual, $expected): void
{
    global $pass, $fail;
    if ($actual === $expected) {
        $pass++;
        echo "  [PASS] {$name}\n";
    } else {
        $fail++;
        echo "  [FAIL] {$name}\n";
        echo "         期望: " . var_export($expected, true) . "\n";
        echo "         实际: " . var_export($actual, true) . "\n";
    }
}

echo "\n=== 越学中文 · 发音评测中转服务 自检 ===\n\n";

// ---- 1. 协议 A：MD5 X-CheckSum ----
echo "[1] 鉴权 · 协议 A（MD5 X-CheckSum）\n";
check(
    'X-CheckSum 拼接顺序与摘要',
    sign_checksum('abcd1234', '1502607694', 'eyAiYXVmIjogImF1ZGlvL0wxNjtyYXR...'),
    '16280c047186814103a779760fadd9c2'
);

// ---- 2. 协议 B：HMAC-SHA256 ----
echo "\n[2] 鉴权 · 协议 B（HMAC-SHA256）\n";
$host = 'api.xfyun.cn';
$date = 'Wed, 11 Aug 2021 06:55:18 GMT';
$line = 'POST /v1/private/http_cn/v1/ise/unicode HTTP/1.1';
$auth = sign_authorization($host, $date, $line, 'YOUR_API_KEY', 'YOUR_API_SECRET');
check(
    'Authorization 固定向量',
    $auth,
    'YXBpX2tleT0iWU9VUl9BUElfS0VZIiwgYWxnb3JpdGhtPSJobWFjLXNoYTI1NiIsIGhlYWRlcnM9Imhvc3QgZGF0ZSByZXF1ZXN0LWxpbmUiLCBzaWduYXR1cmU9InZjNE40aldKN0l5YkpIbHgyRnluYmQ2bXdsd2MxcklUdzd4RWRvNXZTdEU9Ig=='
);
check(
    'Authorization 解码后 headers 字段为 host date request-line',
    strpos(base64_decode($auth), 'headers="host date request-line"') !== false,
    true
);
check(
    'Authorization 解码后不含 request-id',
    strpos(base64_decode($auth), 'request-id') === false,
    true
);

// ---- 3. 归一化：新版结构 ----
echo "\n[3] 结果归一化 · 新版结构（data.result.ws[]）\n";
$newResp = [
    'code' => '0',
    'data' => [
        'result' => [
            'ws' => [
                ['bg' => 0, 'cw' => [['w' => '长', 'sc' => 90.5]], 'ed' => 100, 'ri' => 0, 'type' => 'z', 'rl' => 0],
                ['bg' => 100, 'cw' => [['w' => '城', 'sc' => 80]], 'ed' => 200, 'ri' => 0, 'type' => 'z', 'rl' => 0],
            ],
            'overall_score' => 85.25,
            'phone_score'   => 88.0,
            'tone_score'    => 82.0,
            'pron_coi'      => 79.0,
            'flu_score'     => 90.0,
        ],
        'sid' => 'wse-test-001',
    ],
];
$n = normalize_result($newResp);
check('新版 overall', $n['score']['overall'], 85.3);
check('新版 phone',   $n['score']['phone'], 88.0);
check('新版 words 数量', count($n['words']), 2);
check('新版首字内容', $n['words'][0]['chars'][0]['w'], '长');
check('新版首字得分', $n['words'][0]['chars'][0]['sc'], 90.5);

// ---- 4. 归一化：旧版结构 ----
echo "\n[4] 结果归一化 · 旧版结构（data.read_word.rec_paper）\n";
$oldResp = [
    'code' => '0',
    'desc' => 'success',
    'data' => [
        'read_word' => [
            'lan' => 'cn',
            'rec_paper' => [
                'read_word' => [
                    'is_rejected'   => 'false',
                    'total_score'   => '76.40',
                    'phone_score'   => '80.00',
                    'tone_score'    => '70.00',
                    'fluency_score' => '88.00',
                    'word' => [
                        ['begin_pos' => 0, 'end_pos' => 120, 'content' => '长', 'total_score' => '80.00'],
                        ['begin_pos' => 120, 'end_pos' => 240, 'content' => '城', 'total_score' => '72.80'],
                    ],
                ],
            ],
        ],
    ],
    'sid' => 'wse-test-002',
];
$n = normalize_result($oldResp);
check('旧版 overall', $n['score']['overall'], 76.4);
check('旧版 phone',   $n['score']['phone'], 80.0);
check('旧版 tone',    $n['score']['tone'], 70.0);
check('旧版 fluency', $n['score']['fluency'], 88.0);
check('旧版 words 数量', count($n['words']), 2);
check('旧版首字内容', $n['words'][0]['chars'][0]['w'], '长');
check('旧版 rejected', $n['rejected'], false);

// ---- 5. 归一化：旧版句子结构 ----
echo "\n[5] 结果归一化 · 旧版句子结构\n";
$oldSent = [
    'code' => '0',
    'data' => [
        'read_sentence' => [
            'rec_paper' => [
                'read_sentence' => [
                    'is_rejected'   => 'true',
                    'total_score'   => '40.00',
                    'integrity_score' => '50.00',
                    'sentence' => [
                        [
                            'begin_pos' => 0, 'end_pos' => 300, 'content' => '今天天气很好',
                            'word' => [
                                ['begin_pos' => 0, 'end_pos' => 100, 'content' => '今', 'total_score' => '45.00'],
                                ['begin_pos' => 100, 'end_pos' => 200, 'content' => '天', 'total_score' => '38.00'],
                            ],
                        ],
                    ],
                ],
            ],
        ],
    ],
];
$n = normalize_result($oldSent);
check('旧版句子 overall', $n['score']['overall'], 40.0);
check('旧版句子 pron 由完整度补位', $n['score']['pron'], 50.0);
check('旧版句子 words 展平为 2 个字', count($n['words']), 2);
check('旧版句子 rejected 标记', $n['rejected'], true);

// ---- 6. 畸形响应 ----
echo "\n[6] 结果归一化 · 畸形/空响应（不能抛异常）\n";
$n = normalize_result([]);
check('空响应不抛异常且结构完整',
    (is_array($n['score']) && count($n['score']) === 5 && $n['words'] === []),
    true);
$n = normalize_result(['code' => '0', 'data' => ['result' => []]]);
check('缺 ws 的新版响应退化为 0 分',
    $n['score']['overall'], 0.0);

// ---- 7. 讯飞错误映射 ----
echo "\n[7] 讯飞错误映射（desc 关键词优先）\n";
check('illegal X-CheckSum 指向 api_key',
    strpos(describe_xfyun_error(10105, 'illegal access|illegal X-CheckSum', 'service_form'), 'api_key') !== false,
    true);
check('invalid Headprams 指向 ise_scheme',
    strpos(describe_xfyun_error(10106, 'invalid parameter|invalid Headprams', 'service_form'), 'ise_scheme') !== false,
    true);
check('illegal client_ip 指向白名单',
    strpos(describe_xfyun_error(10105, 'illegal access|illegal client_ip', 'service_form'), '白名单') !== false,
    true);
check('invalid X-Appid 指向 app_id',
    strpos(describe_xfyun_error(10106, 'invalid parameter|invalid X-Appid', 'service_form'), 'app_id') !== false,
    true);
check('额度用尽有对应文案',
    strpos(describe_xfyun_error(11200, 'something', 'service_form'), '授权次数') !== false,
    true);
check('未知 desc 回落到错误码文案',
    strpos(describe_xfyun_error(10304, 'unknown', 'service_form'), '10304') !== false,
    true);

// ---- 汇总 ----
echo "\n=== 结果：{$pass} 通过 / {$fail} 失败 ===\n";
if ($fail > 0) {
    echo "有断言失败，请勿部署。\n";
    exit(1);
}
echo "全部通过，可以部署。\n";
exit(0);
