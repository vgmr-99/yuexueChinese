# 发音评测服务端部署指南（讯飞 ISE → PHP 代理）

本目录是 Athao 学汉语 **发音评测** 功能的唯一服务端。
客户端（APK / 网页）只跟这里的 `ise.php` 通信，讯飞密钥永远不进客户端。

```
手机 App ──HTTPS──▶ 你的 PHP 主机 (ise.php) ──HTTPS──▶ 讯飞 api.xfyun.cn
                     密钥只存在这一层
```

---

## 一、准备

1. **讯飞开放平台**开通「语音评测」服务
   - <https://www.xfyun.cn/app/console> → 应用 → 服务详情 → API/接口调用示例
   - 复制 **AppID / APIKey / APISecret** 三项
   - 个人认证一般有免费额度（新用户默认 500 次/日），足够自测
2. 一台**支持 PHP 7.4+**（含 cURL 扩展）的主机，Apache 或 Nginx 均可

## 二、部署（3 分钟）

```bash
# 1. 上传本目录下的 ise.php 与 .htaccess 到主机，例如
#    主机根目录/athao/api/{ise.php,.htaccess}

# 2. 复制模板并填凭证（在本地改好再上传也行）
cp config.example.php config.php
$EDITOR config.php       # 填 app_id / api_key / api_secret

# 3. 上传 config.php（与 ise.php 同目录，或放到 web 根目录之外）

# 4. 语法自检（在主机 SSH 里，或本地装 PHP 后检查）
php -l ise.php           # 期望输出：No syntax errors detected
```

## 三、验证（不消耗讯飞额度）

```bash
curl -X POST -d '{"action":"ping"}' https://你的域名/athao/api/ise.php
```

成功返回：

```json
{"ok":true,"ping":true,"php_version":"8.1.x","has_curl":true,
 "app_id_masked":"a1b2****","ise_host":"api.xfyun.cn","category":"lv1"}
```

- `has_curl: false` → 主机没装 cURL 扩展，找主机商开通
- `server_not_configured` → `config.php` 没传上去，或三项凭证仍是 `YOUR_xxx`
- 404 / 白屏 → 路径不对，检查网址是否带 `.php` 后缀

## 四、App 里填地址

**设置 → 发音评测服务** → 填入

```
https://你的域名/athao/api/ise.php
```

保存后状态显示「Đã cấu hình / 已配置」即为生效。
回到任意词卡点 **🎤 Phát âm / 发音评测** 即可录音评测。

## 五、安全与合规

| 项 | 说明 |
|---|---|
| **密钥不入客户端** | 绝不要把 APIKey 写进 `web/` 目录或 APK，一反编译即泄露、额度被刷 |
| **config.php 防护** | 同目录 `.htaccess` 已屏蔽；若主机是 Nginx，请在配置里加 `location ~ config\.php { deny all; }` |
| **防盗刷** | 在 `config.php` 填 `allowed_origin`（如 `https://你的域名`），非白名单来源直接拒绝 |
| **隐私** | 录音会上传到你的主机并转发讯飞，正式发布需在隐私政策中说明；个人自用请勿公开分发 |
| **HTTPS** | APK 的 `usesCleartextTraffic="false"`，**必须 HTTPS**。没有证书可用 Cloudflare 免费签发 |

## 六、常见错误速查

| App 提示 | 原因 | 处理 |
|---|---|---|
| `server_not_configured` | `config.php` 缺失或凭证是占位符 | 检查文件是否上传、是否已替换 `YOUR_xxx` |
| `origin_not_allowed` | 来源不在白名单 | 改 `config.php` 的 `allowed_origin` |
| `upstream_unreachable` | 主机连不上讯飞 | 主机需出网；试试 `curl -I https://api.xfyun.cn` |
| `10106 音频过短` | 读得太快/声音太小 | 提示学员读满 0.7 秒以上 |
| `10105 音频格式不符` | 音频不是 16k/16bit/单声道 | 客户端已固定；若仍报错说明被中间层转码了 |
| `10304 音频与文本不匹配` | 读的内容与目标不符 | 确认评测的是中文原文 |
| `11200/11201/11202` | 授权次数用尽 | 讯飞控制台查套餐余量 |

## 七、成本参考（个人量级）

- 讯飞语音评测：套餐约 **¥60 / 万次**（20 万次档），单次评测约 **1 秒音频**
- 免费额度：个人认证新用户 1 万次/90 天；日常默认 500 次/日
- PHP 主机：任意支持 PHP 的虚拟主机即可，本代理不占常驻资源

## 八、当前 App 侧配置键（`config.example.php`）

| 键 | 说明 |
|---|---|
| `category` | `lv1` 初学 / `lv2` 进阶 / `lv3` 高阶。给越南语零基础学员建议保持 `lv1` |
| `dwa` | `wpgs` = 开启音素级评估，能定位平翘舌、前后鼻音问题 |
| `vad_eos` | 静音判停毫秒；整句可调大到 `15000` |
| `language` | `zh_cn` 中文（英文材料才改 `en_us`） |