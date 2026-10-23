#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_audio.py — 预生成中文朗读音频（发音最准方案）

为什么预生成
------------
1. **音质最好**：Edge TTS（微软神经网络语音）是目前中文TTS 音质最好的之一，
   预生成后打包进APK，运行时完全离线，不依赖系统 TTS。
   系统 Web Speech API 的 zh-CN 声音因设备而异（vivo/小米 差别很大），
   且部分机型根本没有中文发音人。
2. **多音字可控**：预生成时可对多音字词做人工校对（如 银行→yín háng），
   系统 TTS 不可控。
3. **体积可接受**：500 词约 8 MB，可接受。

音色选择
--------
- XiaoxiaoNeural：女声，清晰自然，**默认首选**（教学场景友好）
- YunxiNeural：男声，青年音，适合快速学习对比
- XiaoyiNeural：女声，偏活泼

若Edge TTS 不可用（无网络），自动回退到本地 sherpa-onnx
（vits-zh-ll，5 个发音人，16kHz）。

用法
----
    python tools/build_audio.py \
        --vocab data/vocab.json \
        --out   web/audio/words \
        --engine edge          # edge | sherpa | auto
        --voice zh-CN-XiaoxiaoNeural
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path


# ------------------------------------------------------------ Edge TTS
async def synth_edge(texts: dict[str, str], outdir: Path, voice: str,
                     rate: str = "-10%") -> tuple[int, int]:
    """用 Edge TTS 批量合成。texts: {文件名: 文本}"""
    try:
        import edge_tts
    except ImportError:
        return 0, -1

    ok = 0
    fail = 0
    sem = asyncio.Semaphore(6)          # 限制并发，避免被限流

    async def one(name: str, text: str) -> None:
        nonlocal ok, fail
        target = outdir / f"{name}.mp3"
        if target.exists() and target.stat().st_size > 500:
            ok += 1                            # 已生成则跳过（增量）
            return
        async with sem:
            for attempt in range(3):
                try:
                    comm = edge_tts.Communicate(text, voice, rate=rate)
                    await comm.save(str(target))
                    ok += 1
                    return
                except Exception:
                    if attempt == 2:
                        fail += 1
                    else:
                        await asyncio.sleep(1.2 * (attempt + 1))

    await asyncio.gather(*(one(n, t) for n, t in texts.items()))
    return ok, fail


# ------------------------------------------------------------ sherpa-onnx 回退
def synth_sherpa(texts: dict[str, str], outdir: Path, model_dir: Path,
                 speaker: int = 0) -> tuple[int, int]:
    try:
        import sherpa_onnx
        import numpy as np
    except ImportError:
        return 0, -1

    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(model_dir / "model.onnx"),
                lexicon=str(model_dir / "lexicon.txt"),
                tokens=str(model_dir / "tokens.txt"),
                dict_dir=str(model_dir / "dict"),
            ),
            num_threads=2, provider="cpu",
        ),
        max_num_sentences=1,
    )
    tts = sherpa_onnx.OfflineTts(cfg)

    import wave
    ok = 0
    fail = 0
    for name, text in texts.items():
        target = outdir / f"{name}.mp3"
        if target.exists() and target.stat().st_size > 500:
            ok += 1
            continue
        try:
            audio = tts.generate(text, sid=speaker, speed=1.0)
            # sherpa 输出 PCM，封装成 wav（webview 原生支持 wav）
            wav_path = outdir / f"{name}.wav"
            with wave.open(str(wav_path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(audio.sample_rate)
                samples = np.asarray(audio.samples, dtype=np.int16)
                w.writeframes(samples.tobytes())
            ok += 1
        except Exception:
            fail += 1
    return ok, fail


def collect_texts(vocab: dict, levels: list[int]) -> dict[str, str]:
    """收集要合成的词条文本：文件名 -> 文本"""
    items: dict[str, str] = {}
    for lv in levels:
        key = str(lv)
        if key not in vocab.get("levels", {}):
            continue
        for item in vocab["levels"][key]:
            w = item["hanzi"]
            items[f"w_{w}"] = w
    return items


def collect_sentences(app_data_path: Path) -> dict[str, str]:
    """从 app-data.js 收集课程句子：文件名 -> 句子文本。

    文件名格式 s_<课号>_<句号>，与前端 renderCourse 的索引对应。
    这里刻意保留标点，听力练习需要完整句子语调。
    """
    raw = app_data_path.read_text(encoding="utf-8")
    data = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
    out: dict[str, str] = {}
    for ci, course in enumerate(data.get("courses", [])):
        for si, s in enumerate(course.get("sentences", [])):
            out[f"s_{ci}_{si}"] = s["hanzi"]
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="预生成中文朗读音频")
    ap.add_argument("--vocab", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--engine", default="auto",
                    choices=["edge", "sherpa", "auto"])
    ap.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    ap.add_argument("--levels", default="1",
                    help="要合成的等级，逗号分隔，如 1 或 1,2,3")
    ap.add_argument("--sherpa-model", type=Path,
                    default=Path("data/tts/sherpa-onnx-vits-zh-ll"))
    ap.add_argument("--app-data", type=Path, default=None,
                    help="app-data.js，用于生成课程句子音频（--mode sentence）")
    ap.add_argument("--mode", default="words",
                    choices=["words", "sentence"],
                    help="words=词条音频(w_xxx.mp3)，sentence=课程句子(s_x_y.mp3)")
    ap.add_argument("--limit", type=int, default=0, help="调试：只合成前 N 个")
    args = ap.parse_args()

    if args.mode == "sentence":
        if not args.app_data or not args.app_data.exists():
            raise SystemExit("--mode sentence 需要 --app-data web/data/app-data.js")
        texts = collect_sentences(args.app_data)
    else:
        vocab = json.loads(args.vocab.read_text(encoding="utf-8"))
        levels = [int(x) for x in args.levels.split(",") if x.strip()]
        texts = collect_texts(vocab, levels)
    if args.limit:
        texts = dict(list(texts.items())[:args.limit])

    args.out.mkdir(parents=True, exist_ok=True)
    print(f"待合成 {len(texts)} 条-> {args.out}")

    engine = args.engine
    ok = fail = 0

    if engine in ("edge", "auto"):
        ok, fail = asyncio.run(synth_edge(texts, args.out, args.voice))
        if fail == -1:
            print("[Edge TTS] 不可用，尝试 sherpa-onnx")
            engine = "sherpa"
        elif fail and fail > ok * 0.3:
            print(f"[Edge TTS] 失败率偏高({fail}/{ok+fail})，部分回退 sherpa")
            missing = {
                n: t for n, t in texts.items()
                if not (args.out / f"{n}.mp3").exists()
            }
            if missing:
                s_ok, s_fail = synth_sherpa(missing, args.out, args.sherpa_model)
                ok += s_ok
                fail = s_fail
        else:
            print(f"[Edge TTS] 完成 {ok} 条，失败 {fail}")

    if engine == "sherpa" and ok == 0 and fail == 0:
        ok, fail = synth_sherpa(texts, args.out, args.sherpa_model)
        print(f"[sherpa-onnx] 完成 {ok} 条，失败 {fail}")

    total_bytes = sum(f.stat().st_size for f in args.out.iterdir()
                      if f.is_file())
    print(f"[输出] {args.out}  共 {ok} 个音频，"
          f"总体积 {total_bytes / 1024 / 1024:.1f} MB")

    # 生成清单，前端据此判断是否有音频。
    # 注意：必须保留 "w_" 前缀（build_appdata.py 用 f"w_{词}" 匹配），
    # 且要排除 manifest.json 自身。
    files = sorted(
        p.stem for p in args.out.iterdir()
        if p.is_file() and p.suffix == ".mp3"
    )
    manifest = args.out / "manifest.json"
    manifest.write_text(json.dumps(files, ensure_ascii=False),
                        encoding="utf-8")
    print(f"[清单] {manifest}  {len(files)} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())