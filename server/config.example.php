<?php
/**
 * config.example.php — 讯飞语音评测（ISE）中转服务配置
 *
 * 部署步骤
 * --------
 * 1. 复制本文件为 config.php（同目录）
 * 2. 填入讯飞开放平台「语音评测」应用的三项凭证
 * 3. **务必配置访问防护**（proxy_key / rate_limit），否则你的讯飞额度
 *    等于公开给任何人刷 —— 见下方「安全」一节
 * 4. 若 web 根目录能访问 config.php，请确保同目录 .htaccess 已生效；
 *    更稳妥的做法：把本文件放到 web 根目录**之外**，
 *    并修改 ise.php 中 CONFIG_FILE 常量指向它。
 *
 * 凭证在讯飞控制台获取：
 *   https://www.xfyun.cn/app/console → 语音评测 → 服务详情 → API/接口调用示例
 *   AppID / APIKey / APISecret
 */

return [
    // ---- 必填 ----
    'app_id'     => 'YOUR_APPID',          // 例如 a1b2c3d4
    'api_key'    => 'YOUR_API_KEY',         // 32 位
    'api_secret' => 'YOUR_API_SECRET',      // 32 位

    // ---- 上游协议 ----
    //
    // 讯飞「语音评测」有两套在用的协议，必须与你的账号开通的产品匹配，
    // 配错了会返回 10106（请求头无效）或 10005（参数错误）。
    //
    //   service_form  讯飞「语音评测（普通版）」
    //                 https://api.xfyun.cn/v1/service/v1/ise/unicode
    //                 请求头 X-CheckSum = MD5(apiKey + X-CurTime + X-Param)
    //                 请求体 表单 audio + text
    //
    //   http_cn_json  讯飞「语音评测（中文版）」WebAPI
    //                 https://api.xfyun.cn/v1/private/http_cn/v1/ise/unicode
    //                 请求头 Authorization = HMAC-SHA256
    //                 请求体 JSON {business, data}
    //
    // 拿不准就先跑 service_form：自检页会告诉你上游返回了什么。
    // 讯飞新开通的账号通常只有「流式版」（WebSocket），那种产品本脚本
    // 暂不支持，需要改成 wss://ise-api.xfyun.cn/v2/open-ise。
    'ise_scheme' => 'service_form',

    'ise_url'    => 'https://api.xfyun.cn/v1/service/v1/ise/unicode',

    // ---- 评测参数 ----
    //
    // 题型（service_form 协议）：
    //   read_syllable 单字朗读（汉语专有） / read_word 词语朗读
    //   read_sentence 句子朗读 / read_chapter 篇章朗读
    //
    // 题型（http_cn_json 协议）：
    //   read_syllable / read_word / read_sentence / read_chapter
    'category'   => 'read_sentence',

    // 语言：zh_cn 中文 / en_us 英文
    'language'   => 'zh_cn',

    // 是否开启音素级评估（wpgs）。开启后返回每个字的音素得分，
    // 越南语母语者的平翘舌/前后鼻音问题就能精确定位。
    'dwa'        => 'wpgs',

    // 单次最长录音（毫秒）。讯飞对单次评测的音频时长有上限，
    // 单词 ≤5s，整句建议 ≤15s，超出会报 10105/参数错误。
    'vad_eos'    => '10000',

    // 采样率固定 16k（讯飞要求）
    'sample_rate'=> '16000',

    // 试题前缀。部分接口要求 '[content]' 开头；
    // 若评测报 10005 参数错误，可以试这里加 '[content]'。
    'text_prefix'=> '',

    // 开启全维度评分（准确度/流畅度/完整度等）。
    // 需要讯飞账号开通对应权限，否则该字段会被忽略。
    'extra_ability' => '',

    // ---- 安全（三项都要配）----
    //
    // 1) 代理访问口令：客户端请求必须带 X-Proxy-Key 头，值与此处一致。
    //    这是最有效的一道防线 —— 没有它，别人只要知道地址就能用你的额度。
    //    在 App 的「设置 → 发音评测服务 → 代理访问口令」里填同一个值。
    'proxy_key'  => 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',

    // 2) 每 IP 每分钟请求数上限（0 = 不限，不建议）。
    'rate_limit'         => 20,
    'rate_limit_window'  => 60,

    // 3) 来源白名单（辅助手段，不是安全边界 —— Origin 可被非浏览器伪造）。
    // 例：'https://your-domain.com'
    'allowed_origin' => '',

    // 只有在你确实处于反向代理后面、且代理会正确设置 X-Forwarded-For 时，
    // 才把它设为 true；否则攻击者可以随便伪造 IP 绕过限流。
    'trust_x_forwarded_for' => false,
];
