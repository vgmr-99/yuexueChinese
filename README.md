# 越学中文（VietChinese）— 越南人从 0 学中文

目标是让**零基础越南人**从拼音到会说会认中文。

> 越学汉语 · 研究用途 · 非商用

## 能力一览

| 能力 | 说明 |
|------|------|
| **HSK 1-6 词库** | **5,456 词**（500/772/973/1000/1071/1140），按等级筛选，分页加载 |
| **汉越音** | **5,456/5,456（100%）**，含 131 条词级消歧 + 310 字补充表 |
| **双语界面** | 中文 / 越南语，一键切换 |
| **中文 TTS** | Edge TTS 预生成 **5,580 条**（词 5,342 + 句 200 + 拼音 38），离线播放 |
| **SRS 间隔重复** | SM-2 算法，答对递增间隔、答错重置，解决「学了忘」 |
| **笔顺动画** | **1,887 个汉字**笔顺，可播放 + 描红测验 |
| **拼音** | 声母 21 + 韵母 33 + 声调 4 + 拼读 16 组 + 越南学员教学要点 6 条 |
| **分级课程句子** | **39 课 200 句，覆盖 HSK 1-6**，按等级筛选，每句带汉越音 |
| **测验** | 卡片式 UI：进度条、大汉字题干（无拼音）、选项含拼音与释义 |
| **听写模式** | 听发音→选字作答→判分，补上「认」的主动回忆闭环 |
| **错词本** | 测验/SRS/听写答错自动收录，答对自动移除 |
| **深色模式** | 跟随系统，全站适配 |
| **跨级搜索** | 查词不再受当前 HSK 等级限制 |
| **每日目标打卡** | 可自定义目标（新词/复习/听力/听写），进度环 + 连续天数 + 7 日打卡 |
| **书写评分** | 笔顺正确率 + 星级 + 速度评级，仅保留最好成绩 |
| **设置与数据** | 学习统计、导出/导入进度、分级重置 |
| **移动端深度适配** | 边到边 + 安全区避让、按压反馈、动态视口、窄屏适配 |
| **完全离线** | 全部资源打包进 APK；在线发音评测**默认关闭**，需自行配置 |

## 数据质量

| 项目 | 覆盖率 | 来源 |
|------|--------|------|
| 越南语释义 | **100%** | CVDICT + 人工补录 |
| 英文释义 | **100%** | CC-CEDICT + 人工补录（词条数据里带英文释义，界面本身只有中/越两种） |
| 汉越音 | **100%** | Unihan + 人工层 403 条 |
| 笔顺 | 1,887 字 | Make Me a Hanzi |
| 音频 | 100%（HSK1-6） | Edge TTS `zh-CN-XiaoxiaoNeural` |

> **仓库不含音频与原始数据**：`web/audio/`、`data/raw/`、`data/tts/` 都在 `.gitignore` 里。
> 克隆后需要自己跑下面的「重新生成数据」才能得到音频，
> 否则 App 里的发音会退回系统 TTS（声音不同，但功能可用）。

## 移动端适配要点

| 项目 | 实现 |
|------|------|
| 刘海屏/手势条 | `viewport-fit=cover` + `env(safe-area-inset-*)`，header 顶部与内容底部自动避让 |
| 触控热区 | 全部可点元素 ≥ 44×44px（`.btn` / `.btn-sm` / `.level-tab` / `.pinyin-tab` / 导航项 / 选项），`npm run smoke` 会在 360/420px × 浅/深色四种组合下逐一实测 |
| 点击反馈 | 去除系统灰块，改用 `:active` 缩放反馈（移动端无 hover） |
| 长按干扰 | 禁用文字选中与长按菜单，输入框除外 |
| 视口高度 | `100dvh` 替代 `100vh`，地址栏收缩时不跳动 |
| 键盘弹出 | `adjustResize` + 输入框字号固定 16px（<16px 会触发 iOS 缩放）|
| 窄屏 | `@media (max-width:360px)` 整体降一档字号 |
| 状态栏 | 浅色 header + 深色状态栏图标；深色模式另配 values-night |
| 屏幕方向 | 锁定竖屏（学习场景无需横屏，规避横屏 inset 复杂度）|

## 目录结构

```
yuexueChinese/
├── data/
│   ├── vocab.json             HSK1-6 词库（越/英/汉越音）
│   ├── hanviet.json           汉越音字表 + 词级表
│   ├── strokes.json           笔顺（1,887 字）
│   ├── wordlist_hanviet.json  词级读音表（手动维护）
│   ├── tts/                   TTS 模型（本地回退用，不进 APK）
│   └── raw/                   原始数据源（不进 git）
├── tools/                     构建管线（19 个脚本）
├── web/                       前端
│   ├── index.html
│   ├── css/{style,refined}.css  refined.css 为质感化覆盖层，后加载
│   ├── js/
│   │   ├── store.js           存储层：键注册表 + 版本迁移 + 写失败上报
│   │   ├── app.js             主逻辑与渲染
│   │   ├── i18n.js            中/越双语
│   │   ├── srs.js             SM-2 间隔重复
│   │   ├── settings.js        统计 / 导出导入 / 重置
│   │   ├── dictation.js       听写
│   │   ├── dailyGoal.js       每日目标与打卡
│   │   ├── strokeScore.js     书写评分
│   │   ├── speech.js          发音评测客户端（讯飞 ISE）
│   │   ├── pinyin.js          拼音规则
│   │   └── sentences.js       课程句子（构建管线输入，不在运行时加载）
│   ├── data/{app-data.js,strokes.json}
│   ├── audio/words/           预生成音频 w_<词>.mp3（不进 git）
│   └── vendor/hanzi-writer.min.js
├── android/                   WebView 套壳
│   └── app/src/main/java/com/vietchinese/app/
│       ├── MainActivity.kt    页面承载、权限、返回键
│       ├── NativeRecorder.kt  原生 AudioRecord 录音 + 麦克风授权桥
│       └── NativeHttp.kt      原生 HTTP 桥（绕开 file:// 跨域）
├── server/                    可选：讯飞发音评测中转（PHP）
└── docs/
```

## 在线发音评测（可选）

评测走 **网页 → JS 桥 → 自建 PHP 代理 → 讯飞**，讯飞密钥永远不进客户端。

- **默认关闭**：不在「设置 → 发音评测服务」填地址就完全离线，
  与「完全离线」的承诺一致；录音不会上传到任何第三方。
- 部署与安全配置见 **[server/README.md](server/README.md)**。
- 代理必须配置访问口令与限流，否则等于公开你的讯飞额度。

## 重新生成数据

> 前置：`data/raw/` 里要有 Unihan、STCharacters、CVDICT、CC-CEDICT、hsk30.csv 等原始文件。
> 这些文件不在仓库里，需要自己从上游获取。

```bash
PY=python

# 1) 汉越音（字表 + 词级表）
$PY tools/build_hanviet.py \
  --unihan data/raw/Unihan.zip --opencc data/raw/STCharacters.txt \
  --learn-chinese data/raw/learn-chinese-hanviet.json \
  --wordlist data/wordlist_hanviet.json \
  --supplement data/hanviet_supplement.json \
  --hsk data/raw/characters.json --out data/hanviet.json

# 2) 词库（HSK1-6，越/英/汉越音）
$PY tools/build_vocab.py \
  --hsk data/raw/hsk30.csv --cvdict data/raw/CVDICT.u8 \
  --cedict data/raw/cedict.txt.gz --hanviet data/hanviet.json \
  --vi-supplement data/vietnamese_supplement.json \
  --max-level 6 --out data/vocab.json

# 3) 笔顺
$PY tools/build_strokes.py \
  --graphics data/raw/graphics.txt --dictionary data/raw/dictionary.txt \
  --hsk data/raw/characters.json --vocab data/vocab.json \
  --out data/strokes.json

# 4) 音频（Edge TTS 预生成；--engine sherpa 可离线回退）
$PY tools/build_audio.py --vocab data/vocab.json \
  --out web/audio/words --engine edge --levels 1,2,3,4,5,6

# 4b) 课程句子音频（需在第 5 步之后跑）
$PY tools/build_audio.py --vocab data/vocab.json \
  --out web/audio/sentences --engine edge --mode sentence \
  --app-data web/data/app-data.js

# 5) 合并成前端数据
$PY tools/build_appdata.py \
  --vocab data/vocab.json --strokes data/strokes.json \
  --hanviet data/hanviet.json --sentences web/js/sentences.js \
  --audio-manifest web/audio/words/manifest.json \
  --out web/data/app-data.js
```

### 发音音频（必读）

**`web/audio/` 不在 git 里**（`.gitignore` 排除，纯媒体约 78 MB），
但它是应用能出声的**前提**。仓库 clone 下来后如果没生成音频：

- APK 里 0 个 mp3 → 所有发音请求 404 → 回退 `speechSynthesis`
- 而 Android WebView 的 `speechSynthesis` 在没有系统 TTS 引擎的机型上是
  **不发声的空壳**（API 存在、`play()` 不 reject、就是没声音）
- 两层静默失败叠加，界面上**没有任何报错**——用户只看到「点了没反应」

所以打 APK 前必须先跑一次：

```bash
$PY -m pip install edge-tts
$PY tools/build_all_audio.py          # 一次性生成 4 类共 7026 个 mp3 / 78.6 MB
```

| 类别 | 数量 | 文件名规则 | 谁在用 |
|---|---|---|---|
| 词条 | 5,342 | `words/w_<汉字>.mp3` | `speak()` 的 `w_<文本>` 键规则 |
| 笔顺单字 | 843 | `words/w_<汉字>.mp3` | 笔顺弹窗朗读单字 |
| 课程句子 | 784 | `sentences/s_<课>_<句>.mp3` | 句子整行与喇叭按钮 |
| 声母/韵母/声调 | 57 | `pinyin/<名称>.mp3` | 拼音卡片 |

脚本支持 `--only {words,sentences,pinyin,strokes}`、`--levels`、`--limit`，
且**断点续传**（已存在且 ≥1KB 的文件会跳过，中断后重跑即可）。

> 笔顺单字与词条音频同目录同命名，因为 `speak()` 的键规则就是 `w_<文本>`——
> 这样笔顺弹窗不必改代码就自动生效。
>
> **体积换体验**：全量音频让 APK 从 8.6 MB 涨到 92 MB。
> 若要小包体，只生成 level 1（500 词）+ 句子 + 拼音，约 8 MB。


### 维护词级汉越音

多音字消歧表在 `data/wordlist_hanviet.json`，改完重跑第 1、2、5 步：

```bash
$PY tools/check_wordlist.py             # 校验词级表（查重复 key）
$PY tools/check_hanviet_supplement.py  # 校验字级补充表
```

> JSON 重复 key 会**静默覆盖**，务必先跑校验脚本。

## 本地预览

```bash
cd web && python -m http.server 8765
```

改完前端记得刷新资源哈希，否则浏览器可能一直用旧 JS：

```bash
$PY tools/stamp_version.py          # 重写 index.html 里的 ?v= 哈希
$PY tools/stamp_version.py --check  # CI 用：校验哈希是否最新
```

## 校验与回归

改完前端跑一遍，四个检查覆盖了最容易「悄悄坏掉」的几件事：

```bash
npm install          # 只装 playwright（devDependency）
npm test             # = 冒烟测试 + i18n 键一致性
npm run shots        # 视觉验收截图，输出到 deliverables/shots/
```

| 命令 | 检查什么 |
| --- | --- |
| `npm run smoke` | 页面无 JS 报错、7 个分区都能渲染、存储层读写、**正文零 emoji**、可点元素 ≥44px、**发音链路正确**（音频无 404、句子整行指向句子音频、关闭笔顺后切语言不复现弹窗） |
| `npm run i18n` | 越/中两套文案键集合必须一致，代码里引用的键必须已定义（少一个界面就直接显示 key 本身） |
| `npm run shots` | 首页 / 词卡 / 测验结果 / 听写结果 / 设置页在浅色深色与手机宽屏下的截图 |
| `php server/selftest.php` | 讯飞鉴权签名固定向量 + 两种响应结构归一化 + 畸形响应不崩，28 条断言 |

GitHub Actions（`.github/workflows/ci.yml`）在每次 push 自动跑上面四项。

> 冒烟测试里的「发音音频无 404」一项在**本地已生成音频时**才生效
> （CI 里没有音频，该项自动跳过）。


## 打 APK

见 [docs/build-apk.md](docs/build-apk.md)。改了网页直接重新 build，
Gradle 会自动把 `web/` 同步到 assets。

## 授权

欢迎进行二次开发，但切勿商用（默认保留所有权利）。
本项目研究/非商用，请保留原作者署名。详见
[docs/data-sources.md](docs/data-sources.md)。
