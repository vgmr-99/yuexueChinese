# Athao 学汉语（VietChinese）— 越南人从 0 学中文

基于 **[ALiangPang/hsk1-chinese-learning](https://github.com/ALiangPang/hsk1-chinese-learning)**
二次开发的**离线**中文学习 App。目标是让**零基础越南人**从拼音到会说会认中文。

> **Athao 学汉语** · 研究用途 · 非商用 · v9

## v9 能力一览

| 能力 | 说明 |
|------|------|
| 📚 **HSK 1-6 词库** | **5,456 词**（500/772/973/1000/1071/1140），按等级筛选，分页加载 |
| 🀄 **汉越音** | **5,456/5,456（100%）**，含 131 条词级消歧 + 310 字补充表 |
| 🌐 **三语界面** | 中文 / 越南语 / 英语，首页一键切换 |
| 🔊 **中文 TTS** | Edge TTS 预生成 **5,580 条**（词 5,342 + 句 200 + 拼音 38），离线播放 |
| 🔁 **SRS 间隔重复** | SM-2 算法，答对递增间隔、答错重置，解决「学了忘」 |
| ✍️ **笔顺动画** | **1,887 个汉字**笔顺，可播放 + 描红测验 |
| 🔤 **拼音** | 声母 21 + 韵母 33 + 声调 4 + 拼读 16 组 + 越南学员教学要点 6 条 |
| 📝 **分级课程句子** | **39 课 200 句，覆盖 HSK 1-6**，按等级筛选，每句带汉越音 |
| ✨ **测验** | 卡片式 UI：进度条、大汉字题干（无拼音）、选项含拼音与释义 |
| 🎧 **听写模式** | 听发音→选字作答→判分，补上「认」的主动回忆闭环 |
| 📕 **错词本** | 测验/SRS/听写答错自动收录，答对自动移除 |
| 🌗 **深色模式** | 跟随系统，全站适配 |
| 🔎 **跨级搜索** | 查词不再受当前 HSK 等级限制 |
| 🎯 **每日目标打卡** | 可自定义目标（新词/复习/听力/听写），进度环 + 连续天数 + 7 日打卡 |
| ✍️ **书写评分** | 笔顺正确率 + 星级 + 速度评级，仅保留最好成绩 |
| ⚙️ **设置与数据** | 学习统计、导出/导入进度、分级重置 |
| 📱 **移动端深度适配** | 边到边+安全区避让、触控热区 ≥44px、按压反馈、动态视口、窄屏/横屏适配 |
| 📴 **完全离线** | 全部资源打包进 APK |

## 数据质量

| 项目 | 覆盖率 | 来源 |
|------|--------|------|
| 越南语释义 | **100%** | CVDICT + 人工补录 25 条 |
| 英文释义 | **100%** | CC-CEDICT + 人工补录 23 条 |
| 汉越音 | **100%** | Unihan + 人工层 403 条 |
| 笔顺 | 1,887 字 | Make Me a Hanzi |
| 音频 | 100%（HSK1-6，5,344 条） | Edge TTS `zh-CN-XiaoxiaoNeural` |

## 移动端适配要点

| 项目 | 实现 |
|------|------|
| 刘海屏/手势条 | `viewport-fit=cover` + `env(safe-area-inset-*)`，header 顶部与内容底部自动避让 |
| 触控热区 | 按钮/选项 ≥ 44×44px（苹果 HIG 与 Android 建议值） |
| 点击反馈 | 去除系统灰块，改用 `:active` 缩放反馈（移动端无 hover） |
| 长按干扰 | 禁用文字选中与长按菜单，输入框除外 |
| 视口高度 | `100dvh` 替代 `100vh`，地址栏收缩时不跳动 |
| 键盘弹出 | `adjustResize` + 输入框字号固定 16px（<16px 会触发 iOS 缩放）|
| 窄屏 | `@media (max-width:360px)` 整体降一档字号 |
| 状态栏 | 主题色与 header 同色（深红 #C0392B），深色模式另配 values-night |
| 屏幕方向 | 锁定竖屏（学习场景无需横屏，规避横屏 inset 复杂度）|

## 目录结构

```
viet-chinese-app/
├── data/
│   ├── vocab.json             HSK1-3 词库（三语 + 汉越音）
│   ├── hanviet.json           汉越音字表 + 词级表
│   ├── strokes.json           笔顺（454 字）
│   ├── wordlist_hanviet.json  词级读音表（手动维护）
│   ├── tts/                   TTS 模型（本地回退用，可不进 APK）
│   └── raw/                   原始数据源
├── tools/                     构建管线
├── web/                       前端
│   ├── index.html
│   ├── js/{app,i18n,srs,settings,dictation,dailyGoal,strokeScore,pinyin,sentences}.js
│   ├── data/{app-data.js,strokes.json}
│   ├── audio/words/           预生成音频 w_<词>.mp3
│   └── vendor/hanzi-writer.min.js
├── android/                   WebView 套壳
└── docs/
```

## 重新生成数据

```bash
PY=python

# 1) 汉越音（字表 + 词级表）
$PY tools/build_hanviet.py \
  --unihan data/raw/Unihan.zip --opencc data/raw/STCharacters.txt \
  --learn-chinese data/raw/learn-chinese-hanviet.json \
  --wordlist data/wordlist_hanviet.json \
  --supplement data/hanviet_supplement.json \
  --hsk data/raw/characters.json --out data/hanviet.json

# 2) 词库（HSK1-3，越/英/汉越音）
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

### 维护词级汉越音

多音字消歧表在 `data/wordlist_hanviet.json`，改完重跑第 1、2、5 步：

```bash
$PY tools/check_wordlist.py             # 校验词级表（查重复 key）
$PY tools/check_hanviet_supplement.py  # 校验字级补充表
```

> ⚠️ JSON 重复 key 会**静默覆盖**，务必先跑校验脚本。

## 本地预览

```bash
cd web && python -m http.server 8765
```

## 打APK

见 [docs/build-apk.md](docs/build-apk.md)。改了网页直接重新 build，
Gradle 会自动把 `web/` 同步到 assets。

## 授权

原版主框架与 learn-chinese 仓库**均无 LICENSE**（默认保留所有权利）。
本项目研究/非商用，请保留原作者署名。详见
[docs/data-sources.md](docs/data-sources.md)。