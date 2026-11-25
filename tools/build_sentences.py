#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_sentences.py — 句子课程扩充管线

作用
----
把 data/sentence_expansion.json 里的新增句合并进 web/js/sentences.js，
并自动补齐拼音（用 pypinyin 的词组词典消歧，避免多音字读错），
最后可选调用 build_audio.py 补音频并做响度归一化。

为什么拼音交给脚本而不是手写
--------------------------
HSK 句子里多音字密集（了、着、长、行、少、得…）。手写拼音容易出错，
而 pypinyin 的词组词典能按整句消歧，与前面词库审计得出的结论一致
（注音以词库为准，音频由讯飞/Edge 生成）。

用法
----
  python tools/build_sentences.py --check          # 只统计，不写文件
  python tools/build_sentences.py --apply          # 合并进 sentences.js
  python tools/build_sentences.py --apply --audio  # 合并 + 生成缺失音频
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "sentence_expansion.json"
TARGET = ROOT / "web" / "js" / "sentences.js"


NODE = "node"


def load_courses() -> list[dict]:
    """从 sentences.js 取出课程数组。

    该文件是 **JS 字面量**（无引号键名 + 单引号字符串），不是合法 JSON，
    Python 的 json 解析不了。借 Node 的 new Function 求值后转成 JSON 传给 Python，
    避免自己写一个不可靠的 JS 解析器。
    """
    import subprocess
    js = (
        "const fs=require('fs');"
        f"const src=fs.readFileSync({str(TARGET)!r},'utf8');"
        "const arr=new Function(src+'; return HSK_SENTENCE_COURSES;')();"
        "process.stdout.write(JSON.stringify(arr));"
    )
    r = subprocess.run([NODE, "-e", js], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise SystemExit(f"解析 sentences.js 失败：{r.stderr[:300]}")
    return json.loads(r.stdout)


# 词库优先：词条里的注音是前面审计+人工校对过的，轻声、多音字都比 pypinyin 准
# （实测 pypinyin 会把 认识 标成 rèn shí、时候 标成 shí hòu，
#   而词库是 rènshi、shíhou —— 后者才是教材标准）
def _load_lexicon() -> dict[str, str]:
    import json as _json
    vp = ROOT / "data" / "vocab.json"
    if not vp.exists():
        return {}
    v = _json.loads(vp.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for items in v.get("levels", {}).values():
        for it in items:
            h, py = it.get("hanzi", ""), it.get("pinyin", "")
            if h and py and re.fullmatch(r"[\u4e00-\u9fff]+", h):
                out[h] = py
    return out


LEX = _load_lexicon()
MAXLEN = max((len(k) for k in LEX), default=1)

# 三声变调：不(bù) 在四声前读 bú，一(yī) 在四声前读 yí
_TONE4 = "\u00e1\u00e0\u00e9\u00ec\u00f3\u00f4\u00fa\u00fc"


def _sandhi(sylls: list[str]) -> list[str]:
    out = list(sylls)
    for i in range(len(out) - 1):
        cur, nxt = out[i], out[i + 1]
        # 用 TONE3 判断末声母，避免依赖声调符号字形
        try:
            from pypinyin import pinyin, Style as _S
            n3 = pinyin(nxt, style=_S.TONE3, neutral_tone_with_five=False)[0][0]
        except Exception:
            n3 = nxt
        if cur in ("bù", "bú") and n3.endswith("4"):
            out[i] = "bú"
        elif cur in ("yī", "yí", "yì") and n3.endswith("4"):
            out[i] = "yí"
        elif cur == "yī" and n3.endswith("3"):
            out[i] = "yī"          # 一 + 三声读原调
        elif cur == "bù" and n3.endswith("3"):
            out[i] = "bù"
    return out


def auto_pinyin(hanzi: str) -> str:
    """句子注音：词库最长匹配优先，剩余字符用 pypinyin 兜底，最后统一做变调处理。"""
    from pypinyin import pinyin, Style
    sylls: list[str] = []
    i, n = 0, len(hanzi)
    while i < n:
        ch = hanzi[i]
        if not re.match(r"[\u4e00-\u9fff]", ch):
            i += 1                      # 标点跳过
            continue
        hit = None
        for L in range(min(MAXLEN, n - i), 1, -1):
            seg = hanzi[i:i + L]
            if seg in LEX:
                hit = (seg, LEX[seg])
                break
        if hit:
            sylls.extend(hit[1].split())
            i += len(hit[0])
        else:
            got = pinyin(ch, style=Style.TONE, errors="ignore")
            if got and got[0]:
                sylls.append(got[0][0])
            i += 1
    return " ".join(_sandhi(sylls))


def js_str(v: str) -> str:
    """转义成 JS 单引号字符串字面量。

    必须转义：拼音里 pypinyin 会用 ASCII 撇号分隔音节（十二 → shí'èr），
    不转义会直接把 JS 字符串截断，导致整文件语法错误。
    """
    return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"


def dump_js(courses: list[dict]) -> str:
    """写回 sentences.js，保留文件头注释与手写风格"""
    head = (
        "// sentences.js — HSK 1-6 分级课程句子\n"
        "//\n"
        "// 本文件由 tools/build_sentences.py 依据 data/sentence_expansion.json 生成，\n"
        "// 拼音由 pypinyin 词组词典自动标注，请勿手改拼音字段。\n"
        "// 字段：hanzi / pinyin / translation(越南语)\n\n"
        # 注意：这里必须带上数组的左括号 [，
        # 否则生成的是 `const X = {..}, {..}` 逗号表达式，
        # 第二个对象会被解析成解构赋值目标而报语法错误
        "const HSK_SENTENCE_COURSES = [\n"
    )
    by_lv: dict[int, list[dict]] = {}
    for c in courses:
        by_lv.setdefault(int(c["level"]), []).append(c)

    lines = [head]
    for lv in sorted(by_lv):
        lines.append(f"  // ==================== HSK {lv} ====================")
        for c in by_lv[lv]:
            lines.append("  {")
            lines.append(f"    level: {lv},")
            lines.append(f"    courseId: {js_str(c['courseId'])},")
            lines.append(f"    courseTitle: {js_str(c['courseTitle'])},")
            lines.append(f"    courseTitleVi: {js_str(c['courseTitleVi'])},")
            lines.append("    sentences: [")
            for s in c["sentences"]:
                lines.append(
                    f"      {{ hanzi: {js_str(s['hanzi'])}, pinyin: {js_str(s['pinyin'])}, "
                    f"translation: {js_str(s['translation'])} }},"
                )
            lines.append("    ],")
            lines.append("  },")
    lines.append("];")
    lines.append("")
    lines.append("if (typeof window !== 'undefined') {")
    lines.append("  window.HSK_SENTENCE_COURSES = HSK_SENTENCE_COURSES;")
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="写入 sentences.js")
    ap.add_argument("--audio", action="store_true", help="生成缺失音频（需 --apply）")
    ap.add_argument("--check", action="store_true", help="只输出统计")
    args = ap.parse_args()

    if not SRC.exists():
        print(f"找不到扩充数据：{SRC}")
        return 1

    expansion = json.loads(SRC.read_text(encoding="utf-8"))
    courses = load_courses()
    by_id = {c["courseId"]: c for c in courses}

    added = skipped = 0
    details = []
    for cid, items in expansion.items():
        c = by_id.get(cid)
        if not c:
            print(f"[!] 课程 id 不存在：{cid}")
            continue
        exist = {s["hanzi"] for s in c["sentences"]}
        before = len(c["sentences"])
        for it in items:
            hz = it["hanzi"].strip()
            if not hz or hz in exist:
                skipped += 1
                continue
            exist.add(hz)
            c["sentences"].append({
                "hanzi": hz,
                "pinyin": it.get("pinyin") or auto_pinyin(hz),
                "translation": it["translation"].strip(),
            })
            added += 1
        details.append((cid, c["courseTitle"], before, len(c["sentences"])))

    total = sum(len(c["sentences"]) for c in courses)
    minc = min(len(c["sentences"]) for c in courses)
    print(f"{'课程':<22}{'原有':>6}{'现有':>6}")
    for cid, t, b, a in details:
        flag = "" if a >= 20 else "  ← 未达 20"
        print(f"{t:<22}{b:>6}{a:>6}{flag}")
    print(f"\n新增 {added} 句，跳过重复 {skipped} 句")
    print(f"总计 {total} 句 / {len(courses)} 分类，平均 {total/len(courses):.1f}，最少 {minc}")

    if args.check:
        return 0
    if not args.apply:
        print("\n（仅统计，未写入。加 --apply 生效）")
        return 0

    TARGET.write_text(dump_js(courses), encoding="utf-8")
    print(f"\n已写入 {TARGET}")

    if args.audio:
        import subprocess
        print("\n生成缺失音频…")
        # 1) 重建 app-data（句子数据源），2) 补音频，3) 响度归一化
        r1 = subprocess.run([sys.executable, str(ROOT / "tools/build_appdata.py"),
                             "--vocab", str(ROOT / "data/vocab.json"),
                             "--strokes", str(ROOT / "data/strokes.json"),
                             "--hanviet", str(ROOT / "data/hanviet.json"),
                             "--sentences", str(TARGET),
                             "--audio-manifest", str(ROOT / "web/audio/words/manifest.json"),
                             "--out", str(ROOT / "web/data/app-data.js")],
                            capture_output=True, text=True)
        print(r1.stdout.strip()[-300:] or r1.stderr[-300:])
        # build_audio.py 的 --vocab 是必填参数（即使 sentence 模式用不到）
        r2 = subprocess.run([sys.executable, str(ROOT / "tools/build_audio.py"),
                             "--mode", "sentence",
                             "--vocab", str(ROOT / "data/vocab.json"),
                             "--app-data", str(ROOT / "web/data/app-data.js"),
                             "--out", str(ROOT / "web/audio/sentences")],
                            capture_output=True, text=True)
        print(r2.stdout.strip()[-400:] or r2.stderr[-400:])
        r3 = subprocess.run([sys.executable, str(ROOT / "tools/normalize_audio.py")],
                            capture_output=True, text=True)
        print(r3.stdout.strip()[-400:] or r3.stderr[-400:])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())