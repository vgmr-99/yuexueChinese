#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_all_audio.py — 一次性生成 APK 需要的全部离线音频

背景
----
web/audio/ 被 .gitignore 排除（纯媒体，~70MB），仓库里没有它。
上一版 APK 因此是「哑」的：所有发音请求 404 -> 回退到
WebView 的 speechSynthesis，而 Android WebView 的 speechSynthesis
在没有系统 TTS 引擎的机型上是个不发声的空壳，
表现就是「点了完全没声音，也没有任何报错」。

这个脚本把三类音频一次性补齐：

  web/audio/words/w_<汉字>.mp3     词条朗读（来自 data/vocab.json）
  web/audio/sentences/s_<课>_<句>.mp3 课程句子（来自 web/data/app-data.js）
  web/audio/pinyin/<名称>.mp3      声母/韵母/声调（来自 web/js/pinyin.js）

音频不进 git，但会被 Gradle 的 syncWebAssets 打进 APK。

用法
----
    python tools/build_all_audio.py                 # 全量
    python tools/build_all_audio.py --only pinyin   # 只补拼音（58 个，最快）
    python tools/build_all_audio.py --limit 50      # 试跑前 50 个
    python tools/build_all_audio.py --levels 1      # 只做 level 1

断点续传：已存在且大小正常的文件会跳过，中断了直接重跑即可。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parent.parent

VOICE = "zh-CN-XiaoxiaoNeural"
RATE = "-10%"          # 教学场景放慢一点
MIN_BYTES = 1024       # 小于这个大小视为失败产物


# ------------------------------------------------------------------ 文本收集
def collect_words(vocab_path: Path, levels: list[int]) -> dict[str, str]:
    """data/vocab.json -> {w_汉字: 汉字}"""
    data = json.loads(vocab_path.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for lv in levels:
        for item in data.get("levels", {}).get(str(lv), []):
            hanzi = item.get("hanzi")
            if hanzi:
                out[f"w_{hanzi}"] = hanzi
    return out


def collect_sentences(app_data: Path) -> dict[str, str]:
    """web/data/app-data.js -> {s_课_句: 句子}（保留标点，语调完整）"""
    raw = app_data.read_text(encoding="utf-8")
    data = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
    out: dict[str, str] = {}
    for ci, course in enumerate(data.get("courses", [])):
        for si, s in enumerate(course.get("sentences", [])):
            hanzi = s.get("hanzi")
            if hanzi:
                out[f"s_{ci}_{si}"] = hanzi
    return out


def collect_pinyin(pinyin_js: Path) -> dict[str, str]:
    """web/js/pinyin.js -> {音频文件名(不含扩展名): 朗读文本}

    每条形如 { id:'b', ..., audio:'initial-b.mp3', ..., say:'玻' }，
    say 是声母/韵母/声调的代表字（教学惯例：用「玻」读 b）。
    返回值去掉 .mp3 —— 扩展名由 synth_batch 统一补，
    否则会拼出 initial-b.mp3.mp3 这种双扩展名。
    """
    src = pinyin_js.read_text(encoding="utf-8")
    pairs = re.findall(
        r"audio:\s*'([^']+)'[^}]*?say:\s*'([^']+)'", src
    )
    out: dict[str, str] = {}
    for name, text in pairs:
        stem = name[:-4] if name.lower().endswith(".mp3") else name
        out[stem] = text
    return out


def collect_stroke_chars(strokes: Path, exclude: set[str]) -> dict[str, str]:
    """web/data/strokes.json -> {w_汉字: 汉字}（仅词库里没有的那些）

    笔顺弹窗朗读单个汉字时走的是 `speak(ch)`，
    而 speak() 的音频键规则是 `w_<文本>`，所以这些字必须也有
    `audio/words/w_<字>.mp3`，否则 404 -> TTS 回退 ->
    Android WebView 无 TTS 引擎 -> 完全无声。

    1887 个笔顺用字里有 843 个不在词库里（多为偏旁/部件/生僻字）。
    """
    data = json.loads(strokes.read_text(encoding="utf-8"))
    chars = data.get("chars", {})
    out: dict[str, str] = {}
    for ch in chars:
        if ch and ch not in exclude:
            out[f"w_{ch}"] = ch
    return out


# ------------------------------------------------------------------ 合成
async def synth_one(text: str, target: Path, sem: asyncio.Semaphore,
                    retries: int = 3) -> bool:
    """合成单个音频。成功返回 True。"""
    async with sem:
        for attempt in range(retries):
            try:
                comm = edge_tts.Communicate(text, VOICE, rate=RATE)
                chunks: list[bytes] = []
                async for ch in comm.stream():
                    if ch["type"] == "audio":
                        chunks.append(ch["data"])
                blob = b"".join(chunks)
                if len(blob) < MIN_BYTES:
                    raise RuntimeError(f"产物过小({len(blob)}B)")
                target.parent.mkdir(parents=True, exist_ok=True)
                # 先写临时文件再改名，避免中断留下半截文件被当成成功
                tmp = target.with_suffix(target.suffix + ".part")
                tmp.write_bytes(blob)
                tmp.replace(target)
                return True
            except Exception as e:            # noqa: BLE001
                if attempt == retries - 1:
                    print(f"    [FAIL] {target.name} ({text}) -> {e}", flush=True)
                    return False
                await asyncio.sleep(1.5 * (attempt + 1))
    return False


async def synth_batch(items: dict[str, str], outdir: Path,
                      concurrency: int, resume: bool) -> tuple[int, int, int]:
    """返回 (成功, 跳过, 失败)"""
    sem = asyncio.Semaphore(concurrency)
    todo: dict[str, str] = {}
    skipped = 0
    for name, text in items.items():
        target = outdir / f"{name}.mp3"
        if resume and target.exists() and target.stat().st_size >= MIN_BYTES:
            skipped += 1
            continue
        todo[name] = text

    total = len(todo)
    if not total:
        print(f"  全部已是最新（跳过 {skipped}）", flush=True)
        return 0, skipped, 0

    print(f"  待合成 {total} 个（已跳过 {skipped}），并发 {concurrency}", flush=True)
    done = 0
    ok = 0
    failed = 0
    t0 = time.time()

    async def worker(name: str, text: str) -> None:
        nonlocal done, ok, failed
        good = await synth_one(text, outdir / f"{name}.mp3", sem)
        done += 1
        if good:
            ok += 1
        else:
            failed += 1
        if done % 50 == 0 or done == total:
            rate = done / max(1e-6, time.time() - t0)
            eta = (total - done) / max(1e-6, rate)
            print(f"    {done}/{total}  失败 {failed}  "
                  f"{rate:.1f}/s  预计剩余 {eta/60:.1f} 分钟", flush=True)

    await asyncio.gather(*(worker(n, t) for n, t in todo.items()))
    return ok, skipped, failed


# ------------------------------------------------------------------ main
def main() -> int:
    ap = argparse.ArgumentParser(description="生成全部离线音频")
    ap.add_argument("--only", choices=["words", "sentences", "pinyin", "strokes"],
                    help="只做其中一类（默认全做）")
    ap.add_argument("--levels", default="1,2,3,4,5,6",
                    help="词条要合成的等级，默认全量")
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0, help="调试：每类只做前 N 个")
    ap.add_argument("--no-resume", action="store_true", help="忽略已有文件，全部重做")
    args = ap.parse_args()

    audio_root = ROOT / "web" / "audio"
    jobs: list[tuple[str, dict[str, str], Path]] = []

    if args.only in (None, "pinyin"):
        jobs.append(("拼音（声母/韵母/声调）",
                     collect_pinyin(ROOT / "web" / "js" / "pinyin.js"),
                     audio_root / "pinyin"))
    if args.only in (None, "sentences"):
        jobs.append(("课程句子",
                     collect_sentences(ROOT / "web" / "data" / "app-data.js"),
                     audio_root / "sentences"))
    if args.only in (None, "words"):
        levels = [int(x) for x in args.levels.split(",") if x.strip()]
        jobs.append(("词条",
                     collect_words(ROOT / "data" / "vocab.json", levels),
                     audio_root / "words"))
    if args.only in (None, "strokes"):
        # 笔顺用字：与词条音频同目录同命名（speak() 的键规则是 w_<文本>），
        # 只补词库里没有的那些，避免重复合成。
        vocab_words = collect_words(ROOT / "data" / "vocab.json", [1, 2, 3, 4, 5, 6])
        have = {t for t in vocab_words.values()}
        jobs.append(("笔顺单字",
                     collect_stroke_chars(ROOT / "web" / "data" / "strokes.json", have),
                     audio_root / "words"))

    print("=" * 64)
    print("音频生成 —— voice=%s rate=%s" % (VOICE, RATE))
    print("=" * 64)

    grand_ok = grand_skip = grand_fail = 0
    for label, items, outdir in jobs:
        if args.limit:
            items = dict(list(items.items())[:args.limit])
        print(f"\n[{label}] 目标 {outdir}", flush=True)
        ok, skip, fail = asyncio.run(
            synth_batch(items, outdir, args.concurrency, not args.no_resume)
        )
        print(f"  -> 成功 {ok} / 跳过 {skip} / 失败 {fail}", flush=True)
        grand_ok += ok
        grand_skip += skip
        grand_fail += fail

    print("\n" + "=" * 64)
    print(f"合计：成功 {grand_ok} / 跳过 {grand_skip} / 失败 {grand_fail}")
    total_bytes = sum(p.stat().st_size for p in audio_root.rglob("*.mp3"))
    print(f"音频总量：{len(list(audio_root.rglob('*.mp3')))} 个文件，"
          f"{total_bytes/1024/1024:.1f} MB")
    print("=" * 64)
    return 1 if grand_fail else 0


if __name__ == "__main__":
    sys.exit(main())
