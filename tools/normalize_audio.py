#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
normalize_audio.py — 全量音频响度归一化

问题（实测）
----------
pinyin 目录 RMS 跨度 21.5 dB：tone-ma1 = -20.2，tone-ma2 = **-36.8**，
差 16.6 dB，人耳非常明显 —— 表现就是「四个声调里只有第一个响」。
words 中位 -23.3，sentences 中位 -20.0 → 跨页切换音量会跳。

方案
----
统一到 TARGET_DBFS = -20.0（以 sentences 的实际听感为基准）：
  gain_db = TARGET - current_rms
  再用峰值限制收口：若 gain 后峰值 > CEIL_DBFS，则压缩增益到刚好不削波
  只处理偏离超过 TOLERANCE_DB 的文件，其余原样保留（避免无意义的二次编码）

原文件先备份到 audio_backup/，可一键还原。
"""
from __future__ import annotations

import shutil
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import lameenc
import miniaudio
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "web" / "audio"
BACKUP = ROOT / "audio_backup"

TARGET_DBFS = -20.0
CEIL_DBFS = -1.0
TOLERANCE_DB = 1.0
MAX_BOOST_DB = 22.0          # 二次补齐：峰值上限会自动兜住削波，允许补得更多
BITRATE = 48                 # 与原始 Edge TTS 输出一致，避免归一化把包体积推大 20MB


def db(x: float) -> float:
    return 20.0 * np.log10(x) if x > 1e-9 else -99.0


def from_db(v: float) -> float:
    return 10.0 ** (v / 20.0)


def process(path_str: str):
    p = Path(path_str)
    try:
        # --- 备份一次（已存在则跳过，避免重复拷贝）---
        rel = p.relative_to(AUDIO)
        bak = BACKUP / rel
        if not bak.exists():
            bak.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, bak)

        # --- 解码 ---
        d = miniaudio.decode_file(str(p), output_format=miniaudio.SampleFormat.FLOAT32,
                                  nchannels=1)
        x = np.array(d.samples, dtype=np.float32)
        if x.size < 256:
            return (p.name, None, None, "太短，跳过")

        sr = d.sample_rate
        cur = float(np.sqrt(np.mean(x ** 2)))
        cur_db = db(cur)
        gain_db = TARGET_DBFS - cur_db

        if abs(gain_db) < TOLERANCE_DB:
            return (p.name, cur_db, 0.0, "已在目标范围内")
        gain_db = max(-40.0, min(gain_db, MAX_BOOST_DB))

        y = x * from_db(gain_db)

        # --- 峰值限制：防止削波失真 ---
        peak = float(np.max(np.abs(y)))
        if peak > from_db(CEIL_DBFS):
            y = y * (from_db(CEIL_DBFS) / peak)
            peak = from_db(CEIL_DBFS)

        # --- 编码回 mp3 ---
        enc = lameenc.Encoder()
        enc.set_bit_rate(BITRATE)
        enc.set_in_sample_rate(sr)
        enc.set_channels(1)
        enc.set_quality(2)
        pcm = np.clip(y, -1.0, 1.0)
        pcm16 = (pcm * 32767.0).astype(np.int16)
        data = enc.encode(pcm16.tobytes())
        data += enc.flush()

        old = p.stat().st_size
        p.write_bytes(bytes(data))
        new_db = db(float(np.sqrt(np.mean(y ** 2))))
        return (p.name, cur_db, new_db, f"{old}B→{p.stat().st_size}B")
    except Exception as e:  # noqa: BLE001
        return (p.name, None, None, f"失败: {type(e).__name__}: {e}")


def main() -> int:
    files = sorted(str(f) for f in AUDIO.rglob("*.mp3"))
    print(f"待处理音频: {len(files)} 个")
    print(f"目标响度 {TARGET_DBFS} dBFS，峰值上限 {CEIL_DBFS} dBFS，容差 ±{TOLERANCE_DB} dB")
    print(f"备份目录 {BACKUP}")
    print("-" * 74)

    changed = 0
    failed = 0
    skipped = 0
    with ProcessPoolExecutor(max_workers=8) as ex:
        for i, (name, before, after, msg) in enumerate(ex.map(process, files), 1):
            if msg.startswith("失败"):
                failed += 1
                print(f"[{i}] {name} {msg}")
            elif after is None:
                skipped += 1
            elif abs(after - before) > TOLERANCE_DB:
                changed += 1
            if i % 500 == 0:
                print(f"  ...已处理 {i}/{len(files)}")

    print("-" * 74)
    print(f"完成：重新编码 {changed} 个，达标跳过 {skipped - failed} 个，失败 {failed} 个")

    # --- 复验 ---
    print("\n复验关键样本：")
    for n in ("tone-ma1", "tone-ma2", "tone-ma3", "tone-ma4"):
        f = AUDIO / "pinyin" / f"{n}.mp3"
        if f.exists():
            d = miniaudio.decode_file(str(f), output_format=miniaudio.SampleFormat.FLOAT32, nchannels=1)
            x = np.array(d.samples, dtype=np.float32)
            print(f"  {n:<12} {db(float(np.sqrt(np.mean(x**2)))):>7.1f} dBFS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())