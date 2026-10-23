<?php
/**
 * config.example.php — 讯飞语音评测（ISE）配置模板
 *
 * 部署步骤
 * --------
 * 1. 复制本文件为 config.php（同目录）
 * 2. 填入讯飞开放平台「语音评测」应用的三项凭证
 * 3. 若 web 根目录能访问 config.php，请确保同目录 .htaccess 已生效；
 *    更稳妥的做法：把本文件放到 web 根目录**之外**，并修改 ise.php 中
 *    CONFIG_FILE 常量指向它。
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

    // ---- 可选：按你的应用类型调整 ----
    // 中文语音评测的接口地址（unicode 版，适合多音字/儿化）
    'ise_url'    => 'https://api.xfyun.cn/v1/private/http_cn/v1/ise/unicode',

    // 难度等级：lv1(初学) / lv2(进阶) / lv3(高阶)；成人用 lv1 偏宽松
    'category'   => 'lv1',

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

    // ---- 安全 ----
    // 允许调用本代理的来源（留空表示不限制）。
    // 填了之后，非白名单来源会被拒绝，用于防止他人白嫖你的额度。
    // 例：'https://your-domain.com'
    'allowed_origin' => '',
];