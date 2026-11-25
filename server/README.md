# 发音评测服务端部署指南（讯飞 ISE → PHP 代理）

本目录是「越学中文」**发音评测**功能的唯一服务端。
客户端（APK / 网页）只跟这里的 `ise.php` 通信，讯飞密钥永远不进客户端。

```
手机 App ──HTTPS──▶ 你的 PHP 主机 (ise.php) ──HTTPS──▶ 讯飞 api.xfyun.cn
                     密钥只存在这一层
```

---

## 〇、先读这一段（重要）

**评测功能默认关闭。** App 里不填代理地址就完全离线，与 README「完全离线」的承诺一致。
需要评测时在「设置 → 发音评测服务」里填地址 + 代理口令才会启用。

讯飞「语音评测」有多个产品版本，对应**不同的接口与鉴权方式**，
配错会直接报错。`config.php` 里的 `ise_scheme` 必须与账号开通的产品一致：

| `ise_scheme` | 讯飞产品 | 接口地址 | 鉴权 |
|---|---|---|---|
| `service_form`（默认） | 语音评测（普通版） | `https://api.xfyun.cn/v1/service/v1/ise/unicode` | `X-CheckSum = MD5(apiKey + X-CurTime + X-Param)` |
| `http_cn_json` | 语音评测（中文版）WebAPI | `https://api.xfyun.cn/v1/private/http_cn/v1/ise/unicode` | `Authorization` HMAC-SHA256 |

> **实测提醒（2026-11）**：`/v1/private/http_cn/v1/ise/unicode` 目前返回 **404**，
> 该端点已不可用。若你的账号只有「流式版」（WebSocket，`wss://ise-api.xfyun.cn/v2/open-ise`），
> 本脚本暂不支持，需要另做 WebSocket 客户端。请先用 `service_form` 试。

---

## 一、准备

1. **讯飞开放平台**开通「语音评测」服务
   - <https://www.xfyun.cn/app/console> → 应用 → 服务详情 → API/接口调用示例
   - 复制 **AppID / APIKey / APISecret** 三项
   - 个人认证一般有免费额度（新用户默认 500 次/日），足够自测
2. 一台**支持 PHP 7.4+**（含 cURL 扩展）的主机，Apache 或 Nginx 均可

## 二、部署（3 分钟）

```bash
# 1. 上传本目录下的 ise.php、selftest.php 与 .htaccess 到主机，例如
#    主机根目录/api/{ise.php,selftest.php,.htaccess}

# 2. 复制模板并填凭证（在本地改好再上传也行）
cp config.example.php config.php
$EDITOR config.php       # 填 app_id / api_key / api_secret / proxy_key

# 3. 上传 config.php（与 ise.php 同目录，或放到 web 根目录之外）

# 4. 跑自检（**强烈建议先跑这一步**，不消耗讯飞额度）
php selftest.php         # 期望：22 通过 / 0 失败
php -l ise.php           # 期望输出：No syntax errors detected
```

`selftest.php` 会用固定向量校验鉴权算法、用两种真实返回结构校验结果归一化。
**如果它挂了，不要部署** —— 说明代码被改坏了。

## 三、验证（不消耗讯飞额度）

```bash
# ping 需要带代理口令
curl -X POST -H "X-Proxy-Key: 你的口令" \
     -d '{"action":"ping"}' https://你的域名/api/ise.php
```

成功返回：

```json
{"ok":true,"ping":true,"php_version":"8.1.x","has_curl":true,
 "app_id_masked":"a1b2****","ise_host":"api.xfyun.cn","ise_scheme":"service_form"}
```

浏览器打开 `https://你的域名/api/ise.php?key=你的口令` 可以看到可视化自检页
（PHP 版本、cURL、凭证状态、防护配置、讯飞主机）。

- `has_curl: false` → 主机没装 cURL 扩展，找主机商开通
- `server_not_configured` → `config.php` 没传上去，或三项凭证仍是 `YOUR_xxx`
- `proxy_key_invalid` → 没带口令，或口令不一致
- 404 / 白屏 → 路径不对，检查网址是否带 `.php` 后缀

## 四、App 里填地址

**设置 → 发音评测服务** → 填入两处：

| 输入框 | 内容 |
|---|---|
| 服务地址 | `https://你的域名/api/ise.php` |
| 代理访问口令 | 与 `config.php` 里的 `proxy_key` 一致 |

保存后状态显示「Đã cấu hình / 已配置」即为生效。
回到任意词卡点 **发音评测** 即可录音评测。

## 五、安全与合规

| 项 | 说明 |
|---|---|
| **密钥不入客户端** | 绝不要把 APIKey 写进 `web/` 目录或 APK，一反编译即泄露、额度被刷 |
| **config.php 防护** | 同目录 `.htaccess` 已屏蔽；若主机是 Nginx，请在配置里加 `location ~ config\.php { deny all; }` |
| **代理口令** | `proxy_key` 是最有效的一道防线：没有它，别人只要知道地址就能用你的额度 |
| **限流** | `rate_limit` 每 IP 每分钟上限，防止单个来源刷爆额度 |
| **来源白名单** | `allowed_origin` 是**辅助**手段 —— Origin 可被非浏览器伪造，不能替代口令与限流 |
| **X-Forwarded-For** | `trust_x_forwarded_for` 默认关闭。只有确定自己处于会正确设置该头的反代后面才打开，否则可被伪造绕过限流 |
| **隐私** | 录音会上传到你的主机并转发讯飞，正式发布需在隐私政策中说明；个人自用请勿公开分发 |
| **HTTPS** | APK 的 `usesCleartextTraffic="false"`，**必须 HTTPS**。没有证书可用 Cloudflare 免费签发 |

> `selftest.php` 与自检页会显示 PHP 版本、AppID 前 4 位、防护配置。
> 部署在公网时请确认这些信息可对外暴露；口令保护已经覆盖了自检页。

## 六、常见错误速查

### 代理自身返回

| 错误 | HTTP | 原因 | 处理 |
|---|---|---|---|
| `proxy_key_invalid` | 401 | 口令缺失或不对 | App 里「代理访问口令」填与 config 相同 |
| `rate_limited` | 429 | 触发限流 | 等一分钟；或调大 `rate_limit` |
| `origin_not_allowed` | 403 | 来源不在白名单 | 改 `config.php` 的 `allowed_origin` |
| `bad_json` / `missing_text` / `missing_audio` | 400 | 请求体不对 | App 侧问题，看客户端日志 |
| `audio_too_large` | 413 | base64 后超过 5MB | 缩短录音（讯飞上限） |
| `upstream_unreachable` | 502 | 主机连不上讯飞 | 主机需出网；`curl -I https://api.xfyun.cn` 自查 |
| `server_not_configured` | 500 | config 缺失或仍是占位符 | 检查文件是否上传、是否已替换 `YOUR_xxx` |

### 讯飞返回（`error` = `xfyun_error`，`hint` 里有中文指引）

| hint 关键词 | 原因 | 处理 |
|---|---|---|
| `illegal X-CheckSum` | 签名不匹配 | 核对 `api_key`；确认服务器时间没跑偏（X-CurTime 用 UTC） |
| `invalid X-Appid` | AppID 不对 | 核对 `app_id` |
| `illegal client_ip` | IP 白名单拦截 | 把主机公网 IP 加进讯飞白名单，或关掉该白名单 |
| `illegal access` | 服务未开通 / 额度为 0 | 讯飞控制台查套餐余量与授权 |
| `invalid Headprams` | 请求头没被识别 | **多半是协议选错**，调 `ise_scheme` |
| `invalid parameter` | 参数无效 | 核对 `category`/`language` 与音频格式 |
| `音频过短` | 读得太快/声音太小 | 提示学员读满 0.7 秒以上 |
| `音频格式不符` | 不是 16k/16bit/单声道 | 客户端已固定；若仍报错说明被中间层转码了 |
| `音频与文本不匹配` | 读的内容与目标不符 | 确认评测的是中文原文 |
| `授权次数已用尽` | 额度用完 | 讯飞控制台查余量 |

## 七、成本参考（个人量级）

- 讯飞语音评测：套餐约 **¥60 / 万次**（20 万次档），单次评测约 **1 秒音频**
- 免费额度：个人认证新用户 1 万次/90 天；日常默认 500 次/日
- PHP 主机：任意支持 PHP 的虚拟主机即可，本代理不占常驻资源

## 八、配置键速查（`config.example.php`）

| 键 | 默认 | 说明 |
|---|---|---|
| `ise_scheme` | `service_form` | 上游协议，必须与讯飞账号开通的产品一致 |
| `ise_url` | 见上表 | 上游接口地址 |
| `category` | `read_sentence` | 题型：`read_syllable` / `read_word` / `read_sentence` / `read_chapter` |
| `language` | `zh_cn` | `zh_cn` 中文 / `en_us` 英文 |
| `dwa` | `wpgs` | 音素级评估，能定位平翘舌、前后鼻音问题 |
| `vad_eos` | `10000` | 静音判停毫秒 |
| `text_prefix` | `''` | 试题前缀；报 10005 时可试 `[content]` |
| `extra_ability` | `''` | 填 `multi_dimension` 开启全维度评分（需账号有权限） |
| `proxy_key` | — | **必填**，客户端 X-Proxy-Key 请求头的值 |
| `rate_limit` / `rate_limit_window` | 20 / 60 | 每 IP 每分钟上限 |
| `allowed_origin` | `''` | 来源白名单（辅助手段） |
| `trust_x_forwarded_for` | `false` | 是否信任 X-Forwarded-For（谨慎开启） |
