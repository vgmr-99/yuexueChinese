#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_strokes.py — 生成汉字笔顺（stroke order）数据集

用途
----
越南学员学中文，「认字」这一关的核心是**笔顺**。本脚本从
Make Me a Hanzi（skishore/makemeahanzi）提取 SVG 笔顺路径，裁剪出
HSK1 词汇范围，避免把 30MB 全量图形塞进 App。

数据来源
--------
- graphics.txt   : {"character":"字","strokes":["M ...","L ...", ...]}
                   每笔是一条 SVG path，配合 hanzi-writer 即可播放动画。
- dictionary.txt : 汉字释义 + decomposition（部件拆分），用于「汉字结构」页。

许可
----
Make Me a Hanzi 图形数据基于 Arphic PL Font（开源），
dictionary.txt 为 CC-BY-SA / Arphic 授权，可自由使用，署名即可。

用法
----
    python tools/build_strokes.py \
        --graphics  data/raw/graphics.txt \
        --dictionary data/raw/dictionary.txt \
        --hsk       data/raw/characters.json \
        --out       data/strokes.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_graphics(path: Path) -> dict[str, dict]:
    """graphics.txt 是逐行 JSON（每行一个字）。"""
    out: dict[str, dict] = {}
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ch = rec.get("character")
            if ch and rec.get("strokes"):
                out[ch] = rec
    return out


def load_dictionary(path: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ch = rec.get("character")
            if ch:
                out[ch] = rec
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="构建笔顺数据集")
    ap.add_argument("--graphics", type=Path, required=True)
    ap.add_argument("--dictionary", type=Path, required=True)
    ap.add_argument("--hsk", type=Path, default=None)
    ap.add_argument("--vocab", type=Path, default=None,
                    help="词库 vocab.json，用于补齐 HSK2/3 用字的笔顺")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    graphics = load_graphics(args.graphics)
    dictionary = load_dictionary(args.dictionary)
    print(f"[源数据] graphics {len(graphics)} 字/ dictionary {len(dictionary)} 字")

    # 目标字符集：HSK 全部实义字 + 部首（部首也要能写笔顺）
    targets: dict[str, dict] = {}
    if args.hsk and args.hsk.exists():
        hv = json.loads(args.hsk.read_text(encoding="utf-8"))
        for rec in hv:
            targets[rec["char"]] = {
                "hsk_level": rec.get("hsk_level", 0),
                "is_radical": bool(rec.get("is_radical")),
            }

    # 若提供词库，则把HSK1-3 所有词用到的字一并纳入
    # （否则 HSK2/3 的字如「银」「桃」查不到笔顺）
    if args.vocab and args.vocab.exists():
        vb = json.loads(args.vocab.read_text(encoding="utf-8"))
        added = 0
        for items in vb.get("levels", {}).values():
            for it in items:
                for ch in it["hanzi"]:
                    if ch not in targets and ch in graphics:
                        targets[ch] = {"hsk_level": it.get("level", 0),
                                       "is_radical": False}
                        added += 1
        print(f"[词库补充] 新增 {added} 个 HSK1-3 用字")

    strokes: dict[str, dict] = {}
    missing: list[str] = []

    for ch, meta in targets.items():
        g = graphics.get(ch)
        if not g:
            missing.append(ch)
            continue
        d = dictionary.get(ch, {})
        strokes[ch] = {
            # hanzi-writer 直接消费：SVG path 数组
            "strokes": g["strokes"],
            "medians": g.get("medians", []),
            "stroke_count": len(g["strokes"]),
            # 结构信息（用于「汉字结构」页）
            "decomposition": d.get("definition", "").split()[0]
            if d.get("definition") else "",
            "radical": d.get("radical", ""),
            "hsk_level": meta["hsk_level"],
            "is_radical": meta["is_radical"],
        }

    payload = {
        "meta": {
            "description": "汉字笔顺 SVG 路径（Make Me a Hanzi），配合 hanzi-writer 播放",
            "source": "skishore/makemeahanzi (Arphic PL Font)",
            "char_count": len(strokes),
        },
        "chars": strokes,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    size_kb = args.out.stat().st_size / 1024
    print(f"[输出] {args.out}  {len(strokes)} 字  {size_kb:.0f} KB")
    if missing:
        print(f"[无笔顺数据] {len(missing)} 个: {''.join(missing[:40])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())