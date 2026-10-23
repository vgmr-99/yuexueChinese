#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_appdata.py — 合并生成前端数据（v2：多等级词库 + 三语 + 笔顺）

输入
----
data/vocab.json      build_vocab.py 产出（HSK1-3 多等级，越/英/汉越音）
data/strokes.json    build_strokes.py 产出（笔顺）
data/hanviet.json    build_hanviet.py 产出（汉越音，供句子补读音）
web/js/sentences.jsALiangPang 原课程句子

输出
----
web/data/app-data.js挂到 window.APP_DATA

相对 v1 的变化
--------------
1. 词库从 152 词扩到 HSK1-3 共 2245 词，按等级分组，支持等级筛选
2. 每词带越南语 + 英语 + 汉越音，按当前界面语言显示对应释义
3. 附带笔顺信息（逐字）
4. 课程句子也带汉越音
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

PUNCT = "！？。，、；：""''（）《》…—,.?!;:\"'()[]{}~·　 \t"


def strip_punct(s: str) -> str:
    return "".join(ch for ch in s if ch not in PUNCT)


def load_js_array(path: Path, var_name: str) -> list:
    """从 JS 文件里抽出数组字面量。

    不能用 `\\[.*?\\]` 非贪婪匹配——课程数据含嵌套数组（sentences: [...]），
    会提前截断。改用括号配对逐层扫描，定位到真正配平的 `]`。
    """
    text = path.read_text(encoding="utf-8")
    m = re.search(rf"const\s+{var_name}\s*=\s*\[", text)
    if not m:
        raise SystemExit(f"未在 {path} 中找到 {var_name}")

    start = m.end() - 1          # 指向 '['
    depth = 0
    end = -1
    in_str = False
    quote = ""
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                in_str = False
            continue
        if ch in "\"'":
            in_str = True
            quote = ch
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end == -1:
        raise SystemExit(f"{var_name} 数组未配平")

    raw = text[start:end + 1]
    # 去掉 // 行注释（JS 允许，JSON 不允许）
    raw = re.sub(r"^\s*//.*$", "", raw, flags=re.M)
    raw = re.sub(r"//[^\n\"']*", "", raw)
    # JS 对象是无引号 key，补引号后才能json 解析
    raw = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', raw)
    # 单引号字符串 -> 双引号（需先转义内部的反斜杠与双引号）
    def _dq(mm):
        return '"' + mm.group(1).replace('\\"', '\\\\"').replace("'", "\\'") + '"'
    raw = re.sub(r"'((?:[^'\\]|\\.)*)'", _dq, raw)
    # JS 允许尾随逗号，JSON 不允许
    raw = re.sub(r",(\s*[}\]])", r"\1", raw)
    return json.loads(raw)


def read_hanviet(path: Path) -> tuple[dict, dict]:
    d = json.loads(path.read_text(encoding="utf-8"))
    return {k: v["han_viet"] for k, v in d["chars"].items()}, d.get("words", {})


def hanviet_for(word: str, chars: dict, words: dict) -> str:
    bare = strip_punct(word)
    if not bare:
        return ""
    if bare in words:
        return words[bare]
    parts = []
    for ch in bare:
        hv = chars.get(ch, "")
        if not hv:
            return ""
        parts.append(hv)
    return " ".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser(description="生成前端数据（v2）")
    ap.add_argument("--vocab", type=Path, required=True)
    ap.add_argument("--strokes", type=Path, required=True)
    ap.add_argument("--hanviet", type=Path, required=True)
    ap.add_argument("--sentences", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--audio-manifest", type=Path, default=None)
    args = ap.parse_args()

    vocab = json.loads(args.vocab.read_text(encoding="utf-8"))
    strokes = json.loads(args.strokes.read_text(encoding="utf-8"))["chars"]
    chars, words = read_hanviet(args.hanviet)
    # 优先读新版的 HSK_SENTENCE_COURSES（含 level 与越语课名），
    # 回退到旧版 HSK1_SENTENCE_COURSES
    try:
        sents = load_js_array(args.sentences, "HSK_SENTENCE_COURSES")
    except SystemExit:
        sents = load_js_array(args.sentences, "HSK1_SENTENCE_COURSES")

    audio: set[str] = set()
    if args.audio_manifest and args.audio_manifest.exists():
        audio = set(json.loads(args.audio_manifest.read_text(encoding="utf-8")))

    # ---- 词库：按等级分组 ----
    levels: dict[str, list] = {}
    total = hv_total = en_total = 0
    for lv_key, items in vocab["levels"].items():
        out = []
        for it in items:
            w = it["hanzi"]
            bare = strip_punct(w)
            st_first = strokes.get(bare[0], {}) if bare else {}
            out.append({
                "hanzi": w,
                "pinyin": it.get("pinyin", ""),
                "pos": it.get("pos", ""),
                "level": it.get("level", 1),
                "vi": it.get("vietnamese", ""),
                "en": it.get("english", ""),
                "han_viet": it.get("han_viet", "") or hanviet_for(w, chars, words),
                "variants": it.get("variants", []),
                "stroke_count": st_first.get("stroke_count"),
                "radical": st_first.get("radical", ""),
                "has_audio": f"w_{w}" in audio,
                # 只记汉字本身，逐字笔顺信息统一放全局 CHARS 表
                # （原来每个词内嵌一份，重复率高达 82%，白白撑大 1MB+）
                "chars": list(bare),
            })
            total += 1
            if out[-1]["han_viet"]:
                hv_total += 1
            if out[-1]["en"]:
                en_total += 1
        levels[lv_key] = out

    # ---- 课程句子（按 HSK 等级分组） ----
    sent_out = []
    sent_hv_hit = sent_total = 0
    for course in sents:
        rows = []
        for s in course["sentences"]:
            hv = hanviet_for(s["hanzi"], chars, words)
            sent_total += 1
            if hv:
                sent_hv_hit += 1
            rows.append({
                "hanzi": s["hanzi"],
                "pinyin": s["pinyin"],
                "vi": s["translation"],
                "han_viet": hv,
            })
        sent_out.append({
            "courseId": course["courseId"],
            "level": course.get("level", 1),
            "courseTitle": course["courseTitle"],
            "courseTitleVi": course.get("courseTitleVi", ""),
            "sentences": rows,
        })

    # ---- 全局单字表：char -> {stroke_count, radical} ----
    char_index: dict[str, dict] = {}
    for lv_items in levels.values():
        for it in lv_items:
            for ch in it["chars"]:
                if ch and ch not in char_index:
                    st = strokes.get(ch, {})
                    char_index[ch] = {
                        "stroke_count": st.get("stroke_count"),
                        "radical": st.get("radical", ""),
                    }

    payload = {
        "meta": {
            "version": 3,
            "charCount": len(char_index),
            "vocabTotal": total,
            "hanVietHit": hv_total,
            "englishHit": en_total,
            "audioCount": len(audio),
            "levels": {k: len(v) for k, v in sorted(levels.items())},
            "courseCount": len(sent_out),
        },
        "levels": levels,
        "courses": sent_out,
        "charIndex": char_index,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    js = (
        "// 由 tools/build_appdata.py 自动生成，请勿手改。\n"
        "// v3: HSK1-6 多等级 + 三语 + 笔顺 + 句子分级；单字信息抽到 charIndex\n"
        "window.APP_DATA = " + json.dumps(payload, ensure_ascii=False) + ";\n"
    )
    args.out.write_text(js, encoding="utf-8")

    print(f"[词库] {total} 词，等级分布 {payload['meta']['levels']}")
    print(f"[汉越音] {hv_total}/{total} ({hv_total * 100 // max(total, 1)}%)")
    print(f"[英文] {en_total}/{total} ({en_total * 100 // max(total, 1)}%)")
    print(f"[音频] 已预生成 {len(audio)} 条")
    by_lv = {}
    for c in sent_out:
        by_lv.setdefault(str(c["level"]), 0)
        by_lv[str(c["level"])] += 1
    print(f"[课程] {len(sent_out)} 课，等级分布 {by_lv}")
    print(f"[课程汉越音] {sent_hv_hit}/{sent_total} "
          f"({sent_hv_hit * 100 // max(sent_total, 1)}%)")
    print(f"[输出] {args.out}  {args.out.stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())