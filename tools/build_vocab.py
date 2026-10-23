#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_vocab.py — 从 HSK 3.0 官方词表构建多等级词库（含越南语释义 + 汉越音）

输入
----
data/raw/hsk30.csvHSK 3.0 完整词表（MIT, ivankra/hsk30）
                     字段：Simplified / Pinyin / POS / Level
data/raw/CVDICT.u8   中越词典（CC-BY-SA 4.0, ph0ngp/CVDICT）
                     格式：繁简 [pinyin] /释义1/释义2/
data/raw/cedict.txt.gz  CC-CEDICT 官方词典（CC BY-SA 4.0, MDBG）
                     提供**英文**释义，用于三语界面
data/hanviet.json    build_hanviet.py 产出（提供汉越音）

输出
----
data/vocab.json按 HSK 等级分组的词库（越南语 + 英文 + 汉越音）

数据质量说明（重要）
--------------------
CVDICT 的越南语释义由 CC-CEDICT 机器翻译而来，**含噪声**，本脚本做了清洗：
  1. 剔除「LT:」「JK:」「Q:」等标记残留与方括号音标
  2. 剔除越南语词性标签残留（如 "Lượng từ: 個|个"）
  3. 只取前 2 条释义，避免过长
  4. 过滤纯符号/数字条目
若清洗后释义为空，则回退到另一词典，标记 needs_translation 供人工补。

中文释义说明
------------
中文界面下释义直接显示**汉字本身 + 拼音**（学习者以形义对应为主），
不额外生成中文释义，避免机器翻译引入错误。
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
import sys
from pathlib import Path

# 中文标点，计算汉越音前需剥离
PUNCT = "！？。，、；：""''（）《》…—,.?!;:\"'()[]{}~·　 \t"

# CVDICT 噪声：形如 LT: / JK: / Q: / 附注 后的内容，以及方括号音标
NOISE_TAG = re.compile(r"\b(LT|JK|Q|ADJ|ADV|TP|V|CL|PRON)\s*:", re.I)
BRACKET_PINYIN = re.compile(r"\[[^\]]*\]")
# 纯数字/符号
ONLY_SYMBOLS = re.compile(r"^[\W\d_]+$")

# 越南语词性/量词标签残留，如 "Lượng từ: 個|个, 名"
# （CVDICT 机器翻译把 CC-CEDICT 的英文结构标签翻成了越南语，需一并剔除）
VI_LABEL = re.compile(
    r"(Lượng\s*từ|Danh\s*từ|Động\s*từ|Tính\s*từ|Trợ\s*từ|"
    r"Giới\s*từ|Liên\s*từ|Hậu\s*từ|Nhân\s*xưng|Chữ\s*Hán|"
    r"loại\s*từ|số\s*từ|phó\s*từ)\s*:",
    re.I,
)

# HSK 词表里的注解词形，如 "子（桌子）" -> 主词 "子"，注解 "桌子"
ANNOTATED = re.compile(r"^(.+?)（(.+?)）$")
# HSK 用数字区分同形异义：称1/称2、面1/面2 —— 数字仅作区分标记，不是词的一部分
SENSE_MARK = re.compile(r"^([一-鿿]+)[0-9]+$")


def strip_punct(s: str) -> str:
    return "".join(ch for ch in s if ch not in PUNCT)


def clean_defs(raw: str) -> list[str]:
    """清洗单条 CC-CEDICT 释义，返回干净的释义列表。

    关键：CC-CEDICT 的结构化标签（LT:/Lượng từ:等）常常**跟在有效释义后面**，
    例如「世界: /thế giới (LT:個|个[ge4])/」——「thế giới」是有效释义，
    只有括号里的标签是噪声。所以这里必须**剥离标签**而不是整段丢弃。
    """
    if not raw:
        return []
    parts = raw.split("/")
    out: list[str] = []
    for p in parts:
        p = p.strip()
        if not p:
            continue

        # 1) 整段只有标签（以标签开头）-> 丢弃
        if NOISE_TAG.match(p) or VI_LABEL.match(p):
            continue

        # 2) 标签跟在释义后面 -> 剥离标签及其括号内容，保留前半
        #    "thế giới (LT:個|个[ge4])" -> "thế giới"
        m = NOISE_TAG.search(p) or VI_LABEL.search(p)
        if m:
            p = p[: m.start()]

        # 3) 去掉方括号音标（[jia1] 之类）与残留括号
        p = BRACKET_PINYIN.sub("", p)
        p = re.sub(r"\([^)]*\)", "", p)      # 成对括号整体去掉
        p = re.sub(r"[（(]\s*$", "", p)      # 剥离标签后残留的孤立左括号
        p = p.strip(" ;,")

        if not p or ONLY_SYMBOLS.match(p):
            continue

        # 释义过长则截断
        if len(p) > 60:
            p = p[:60].rstrip()
        out.append(p)
    return out


def load_cvdict(path: Path) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    with path.open(encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            m = re.match(r"^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+/(.*)/\s*$", line.rstrip())
            if not m:
                continue
            simp = m.group(2)
            if simp in result:
                continue
            defs = clean_defs(m.group(4))
            if defs:
                result[simp] = defs
    return result


def load_cedict_en(path: Path) -> dict[str, list[str]]:
    """CC-CEDICT 官方（gzip），提取英文释义。"""
    result: dict[str, list[str]] = {}
    with gzip.open(path, "rt", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            # 繁 简 [pin1 yin1] /def1/def2/
            m = re.match(r"^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+/(.*)/\s*$", line.rstrip())
            if not m:
                continue
            simp = m.group(2)
            if simp in result:
                continue
            defs = clean_defs(m.group(4))
            if defs:
                result[simp] = defs
    return result


def hanviet_for(word: str, chars: dict, words: dict) -> str:
    """汉越音：词级优先，逐字兜底；任一字缺失则整词不输出。"""
    bare = strip_punct(word)
    if not bare:
        return ""
    if bare in words:
        return words[bare]
    parts: list[str] = []
    for ch in bare:
        hv = chars.get(ch, "")
        if not hv:
            return ""
        parts.append(hv)
    return " ".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser(description="构建 HSK 多等级词库")
    ap.add_argument("--hsk", type=Path, required=True)
    ap.add_argument("--cvdict", type=Path, required=True)
    ap.add_argument("--cedict", type=Path, default=None,
                    help="CC-CEDICT gzip，提供英文释义")
    ap.add_argument("--hanviet", type=Path, required=True)
    ap.add_argument("--vi-supplement", type=Path, default=None,
                    help="人工补录的越南语释义 data/vietnamese_supplement.json")
    ap.add_argument("--max-level", type=int, default=3,
                    help="构建到第几级（1..6）")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    hv = json.loads(args.hanviet.read_text(encoding="utf-8"))
    hv_chars = {k: v["han_viet"] for k, v in hv["chars"].items()}
    hv_words = hv.get("words", {})

    vi = load_cvdict(args.cvdict)
    print(f"[CVDICT] 清洗后可用词条 {len(vi)}")

    en: dict[str, list[str]] = {}
    if args.cedict and args.cedict.exists():
        en = load_cedict_en(args.cedict)
        print(f"[CC-CEDICT] 英文释义词条 {len(en)}")

    # 人工补录的越南语（词典缺失时兜底）+ 英文
    vi_sup: dict[str, list[str]] = {}
    en_sup: dict[str, list[str]] = {}
    if args.vi_supplement and args.vi_supplement.exists():
        raw = json.loads(args.vi_supplement.read_text(encoding="utf-8"))
        vi_sup = {k: [v] for k, v in raw.items()
                  if not k.startswith("_") and k != "_english"}
        raw_en = raw.get("_english", {})
        en_sup = {k: [v] for k, v in raw_en.items() if not k.startswith("_")}
        print(f"[人工补录] 越南语 {len(vi_sup)} 条 / 英文 {len(en_sup)} 条")

    rows = list(csv.DictReader(args.hsk.open(encoding="utf-8")))
    buckets: dict[int, list[dict]] = {}
    stats = {"total": 0, "vi": 0, "hanviet": 0, "need_trans": 0, "en": 0}

    for r in rows:
        try:
            level = int(r["Level"])
        except (ValueError, KeyError):
            continue
        if level > args.max_level:
            continue

        simp_field = r["Simplified"]
        # HSK 表里存在 "爸爸|爸" 这种多写法，取第一个作为主词，
        # 其余作为 variants（词卡可切换显示）
        variants = [v for v in simp_field.split("|") if v]
        word = variants[0]
        # 还可能带注解："子（桌子）" -> "子"，注解词另存
        note = ""
        m = ANNOTATED.match(word)
        if m:
            note = m.group(2)
            word = m.group(1)
        # 剥离义项区分数字（称1 -> 称），否则查不到词典
        sense = ""
        ms = SENSE_MARK.match(word)
        if ms:
            sense = word[-1]
            word = ms.group(1)
        if not word:
            continue

        pinyin = (r.get("Pinyin") or "").split("|")[0].strip()
        pos = (r.get("POS") or "").strip()

        defs = vi.get(word, [])
        # 主词查不到释义时，用注解词再试一次（如 子 无释义但 桌子有）
        if not defs and note:
            defs = vi.get(note, [])
        # 最后回退到人工补录表
        if not defs:
            defs = vi_sup.get(word, [])
            if defs:
                stats["vi_sup"] = stats.get("vi_sup", 0) + 1
        vi_text = "；".join(defs[:2]) if defs else ""
        if vi_text:
            stats["vi"] += 1
        else:
            stats["need_trans"] += 1

        en_defs = en.get(word, [])
        if not en_defs and note:
            en_defs = en.get(note, [])
        if not en_defs:
            en_defs = en_sup.get(word, [])
        en_text = "; ".join(en_defs[:2]) if en_defs else ""
        if en_text:
            stats["en"] += 1

        hv_text = hanviet_for(word, hv_chars, hv_words)
        if hv_text:
            stats["hanviet"] += 1

        buckets.setdefault(level, []).append({
            "hanzi": word,
            "pinyin": pinyin,
            "pos": pos,
            "level": level,
            "vietnamese": vi_text,
            "english": en_text,
            "han_viet": hv_text,
            "variants": variants[1:] if len(variants) > 1 else [],
            "note": note,
            "sense": sense,
            "needs_translation": not vi_text,
        })
        stats["total"] += 1

    payload = {
        "meta": {
            "source": "HSK 3.0 (ivankra/hsk30, MIT) + CVDICT (CC-BY-SA 4.0) + CC-CEDICT",
            "max_level": args.max_level,
            "counts": {str(k): len(v) for k, v in sorted(buckets.items())},
            "total": stats["total"],
            "vietnamese_hit": stats["vi"],
            "english_hit": stats["en"],
            "hanviet_hit": stats["hanviet"],
            "needs_translation": stats["need_trans"],
        },
        "levels": {str(k): v for k, v in sorted(buckets.items())},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    print(f"[HSK1-{args.max_level}] 共 {stats['total']} 词")
    for k, v in sorted(buckets.items()):
        print(f"    HSK{k}: {len(v)}")
    print(f"[越南语释义] {stats['vi']}/{stats['total']} "
          f"({stats['vi'] * 100 // max(stats['total'], 1)}%)，"
          f"待人工翻译 {stats['need_trans']}")
    print(f"[汉越音] {stats['hanviet']}/{stats['total']} "
          f"({stats['hanviet'] * 100 // max(stats['total'], 1)}%)")
    if en:
        print(f"[英文释义] {stats['en']}/{stats['total']} "
              f"({stats['en'] * 100 // max(stats['total'], 1)}%)")
    print(f"[输出] {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())