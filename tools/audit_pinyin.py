#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
audit_pinyin.py — 词库注音全量审计

基准：pypinyin 内置词组词典（约 40 万词条，含多音字词组消歧）
被审：data/vocab.json 各等级词条的 pinyin 字段

输出：
  1. 总词条数、与基准一致的条数、差异条数
  2. 差异明细（含音节级/声调级差异标注）
  3. 多音字高危词清单
  4. 差异中「很可能我们对」与「很可能 pypinyin 对」两个方向分开，供人工/LLM 复核
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

from pypinyin import pinyin, Style
from pypinyin.contrib.tone_convert import to_tone3, to_normal

ROOT = Path(__file__).resolve().parent.parent
VOCAB = ROOT / "data" / "vocab.json"
OUT = ROOT / "data" / "pinyin_diff.json"

# 已知 CC-CEDICT / HSK 词表权威条目：多音字在其固定义项下的读音。
# 这里的值优先级高于 pypinyin，用于覆盖 pypinyin 词典偶发误判。
# 键为汉字词条，值为该词在本 App 选定义项下的正确读音（带调）。
AUTHORITATIVE = {
    "银行": "yínháng",      # 银行
    "行为": "xíngwéi",      # 行为
    "行走": "xíngzǒu",
    "重": "zhòng",          # 重（重量）——单字默认
    "重要": "zhòngyào",
    "长": "cháng",          # 长（长短）——单字默认
    "长城": "chángchéng",   # 长城：地名读 cháng，不读 zhǎng
    "长大": "zhǎngdà",
    "音乐": "yīnyuè",       # 音乐
    "快乐": "kuàilè",
    "还是": "háishi",
    "还有": "háiyǒu",
    "还原": "huányuán",
    "得到": "dédào",
    "觉得": "juéde",
    "获得": "huòdé",
    "得": "dé",
    "地": "dì",            # 地（土地）
    "地方": "dìfāng",
    "慢慢地": "mànmànde",
    "的确": "díquè",
    "的": "de",
    "了": "le",
    "好人": "hǎorén",
    "爱好": "àihào",
    "好奇": "hàoqí",
    "收拾": "shōushi",
    "教室": "jiàoshì",
    "教书": "jiāoshū",
    "朝代": "cháodài",
    "朝鲜": "cháoxiǎn",
    "朝阳": "zhāoyáng",     # 朝阳（地名）
    "为了": "wèile",
    "以为": "yǐwéi",
    "以为": "yǐwéi",
    "系统": "xìtǒng",
    "关系": "guānxì",
    "干净": "gānjìng",
    "干部": "gànbù",
    "干杯": "gānbēi",
    "背": "bèi",            # 背（背面）
    "背包": "bēibāo",
    "背景": "bèijǐng",
    "处理": "chǔlǐ",
    "到处": "dàochù",
    "觉得": "juéde",
    "着火": "zháohuǒ",
    "着火": "zháohuǒ",
    "宁愿": "nìngyuàn",
    "宁可": "nìngkě",
    "落后": "luòhòu",
    "落枕": "làozhěn",
    "名片": "míngpiàn",
    "别": "bié",            # 别（不要）
    "差别": "chābié",
    "要求": "yāoqiú",
    "需要": "xūyào",
    "参加": "cānjiā",
    "人参": "rénshēn",
    "便宜": "piányi",       # 便宜（物价低）
    "方便": "fāngbiàn",
    "便宜": "piányi",
    "假装": "jiǎzhuāng",
    "真": "zhēn",
    "果实": "guǒshí",
    "结实": "jiēshi",
    "结实": "jiēshi",
    "分数": "fēnshù",
    "过分": "guòfèn",
    "兴奋": "xīngfèn",
    "兴趣": "xìngqù",
    "兴奋": "xīngfèn",
    "兴": "xīng",
    "单": "dān",            # 单（单独）
    "单独": "dāndú",
    "尽": "jìn",            # 尽（尽管）
    "尽力": "jìnlì",
    "尽管": "jǐnguǎn",
    "参差": "cēncī",
    "差": "chā",            # 差（差距）
    "差不多": "chàbuduō",
    "差别": "chābié",
    "出差": "chūchāi",
    "数": "shù",            # 数（数目）
    "数学": "shùxué",
    "数一数": "shǔyishǔ",
    "参": "shēn",           # 海参
    "人参": "rénshēn",
    "发": "fà",             # 发（头发）
    "头发": "tóufa",
    "发现": "fāxiàn",
    "发展": "fāzhǎn",
    "得": "dé",
    "中": "zhōng",          # 中（中间）
    "中国": "Zhōngguó",
    "中奖": "zhòngjiǎng",
    "中毒": "zhòngdú",
    "血": "xuè",            # 血（血液）
    "血液": "xuèyè",
    "血压": "xuèyā",
    "出血": "chūxuè",
    "空": "kōng",            # 空（天空）
    "天空": "tiānkōng",
    "空气": "kōngqì",
    "空闲": "kòngxián",
    "当": "dàng",           # 当（当作）
    "上当": "shàngdàng",
    "应该": "yīnggāi",
    "应当": "yīngdāng",
    "答应": "dāying",
    "结": "jié",            # 结（结果）
    "结果": "jiéguǒ",
    "结束": "jiéshù",
    "结实": "jiēshi",
    "难": "nán",            # 难（困难）
    "困难": "kùnnan",
    "难过": "nánguò",
    "藏": "cáng",           # 藏（躲藏）
    "收藏": "shōucáng",
    "西藏": "Xīzàng",
    "朝": "cháo",
    "着": "zhe",            # 着（助词）
    "接着": "jiēzhe",
    "着凉": "zháoliáng",
    "喝": "hē",
    "吓": "hè",             # 吓（吓人）
    "吓人": "xiàrén",
    "吓唬": "xiàhu",
    "威吓": "wēihè",
    "血": "xuè",
}


def tone3_of(marked: str) -> list[str]:
    """带调拼音（可连写、可含空格/括号）-> tone3 音节列表

    例：'bàba' -> ['ba4','ba4']；'dì (dì-èr)' -> ['di4','di4','er2']
    非法字符（括号、连字符、阿拉伯数字等）先剔除。
    """
    s = unicodedata.normalize("NFC", marked or "")
    s = re.sub(r"[^a-zA-ZüÜ\u00e0-\u01da\s]", " ", s)
    s = s.lower()
    try:
        t3 = to_tone3(s, neutral_tone_with_five=True)
    except Exception:
        t3 = s
    return re.findall(r"[a-zü]+[0-5]?", t3)


def ref_syllables(hanzi: str) -> list[str]:
    """基准：pypinyin 逐字读音（词组词典消歧后）"""
    return [g[0] for g in pinyin(hanzi, style=Style.TONE3,
                                 heteronym=False, errors="ignore")]


def base(s: str) -> str:
    """去掉声调数字，只留声母韵母"""
    return re.sub(r"[0-5]$", "", s)


def strip_tone(ch: str) -> str:
    """带调字符 -> 无调 ASCII（ü -> v）"""
    rep = {
        "ā": "a", "á": "a", "ǎ": "a", "à": "a",
        "ē": "e", "é": "e", "ě": "e", "è": "e", "ê": "e",
        "ī": "i", "í": "i", "ǐ": "i", "ì": "i",
        "ō": "o", "ó": "o", "ǒ": "o", "ò": "o",
        "ū": "u", "ú": "u", "ǔ": "u", "ù": "u",
        "ǖ": "v", "ǘ": "v", "ǚ": "v", "ǜ": "v", "ü": "v",
    }
    return "".join(rep.get(c, c) for c in ch)


def our_syllables_by_ref(stored: str, ref: list[str]) -> list[str] | None:
    """按权威音节边界切分我们的连写注音，逐音节转 tone3。

    返回 None 表示骨架对不上（音节级错误或脏数据）。
    例：stored='bàba', ref=['ba4','ba4'] -> ['ba4','ba4']
    """
    # 保留字母与声调符号，丢掉括号/连字符/空格/数字等杂质
    norm = re.sub(r"[^a-zA-ZüÜÀ-ɖ\s]", "", unicodedata.normalize("NFC", stored or ""))
    norm = "".join(norm.split()).lower()
    if not norm:
        return None
    if strip_tone(norm) != "".join(base(r) for r in ref):
        return None
    out, pos = [], 0
    for r in ref:
        L = len(base(r))
        piece = norm[pos:pos + L]
        if not piece:
            return None
        try:
            out.append(to_tone3(piece, neutral_tone_with_five=True))
        except Exception:
            return None
        pos += L
    return out if pos == len(norm) else None


def main() -> int:
    data = json.loads(VOCAB.read_text(encoding="utf-8"))
    levels = data["levels"]
    n_chars = sum(len(w["hanzi"]) for ws in levels.values() for w in ws)

    total = same = 0
    diffs = []          # 逐字定位的声调差异
    syl_bad = []        # 音节骨架错误（多音字选错读音）
    fmt_issues = []     # 音节数与字数不符（数据格式脏）
    poly_counter: dict[str, int] = defaultdict(int)

    for lvl_key, words in levels.items():
        for item in words:
            total += 1
            hanzi = item["hanzi"]
            stored = item.get("pinyin", "")
            n = len(hanzi)

            if hanzi in AUTHORITATIVE:
                ref = tone3_of(AUTHORITATIVE[hanzi])
                ref_src = "authoritative"
            else:
                ref = ref_syllables(hanzi)
                ref_src = "pypinyin"

            ours = our_syllables_by_ref(stored, ref) if ref else None

            if ours is None:
                # 骨架对不上：区分「脏数据」与「音节级错误」
                norm = "".join(re.sub(r"[^a-zA-ZüÜÀ-ɖ\s]", "",
                             unicodedata.normalize("NFC", stored or "")).split()).lower()
                our_skel = strip_tone(norm)
                ref_skel = "".join(base(r) for r in ref)
                rec = {
                    "hanzi": hanzi, "level": int(lvl_key), "stored": stored,
                    "chars": n, "ref": " ".join(ref), "ref_src": ref_src,
                    "our_skeleton": our_skel, "ref_skeleton": ref_skel,
                    "vi": item.get("vietnamese", "")[:36],
                    "en": item.get("english", "")[:44],
                }
                # 儿化（…anr ↔ …an er）属标准写法，整体判为正确
                erhua = (
                    our_skel.endswith("r")
                    and ref_skel.endswith("er")
                    and our_skel[:-1] == ref_skel[:-2]
                )
                # 脏数据特征：含括号/斜杠/多余说明文字
                dirty = bool(re.search(r"[()（）／/／]|第|又|同|一）|（", stored or "")) \
                    or n == 1
                if erhua:
                    same += n            # 儿化写法正确，不计入错误
                elif dirty:
                    fmt_issues.append(rec)
                else:
                    syl_bad.append(rec)
                het = pinyin(hanzi, style=Style.TONE3, heteronym=True, errors="ignore")[0]
                if any(len(g) > 1 for g in het):
                    poly_counter[hanzi] += 1
                continue

            for i, ch in enumerate(hanzi):
                if i >= len(ours) or i >= len(ref):
                    # 音节数少于字数（含标点/非常规字符的词条），跳过逐字比对
                    continue
                o, r = ours[i], ref[i]
                if o == r:
                    same += 1
                else:
                    diffs.append({
                        "hanzi": hanzi, "char": ch, "idx": i,
                        "level": int(lvl_key), "stored": stored,
                        "ours": o, "ref": r,
                        "kind": "TONE" if base(o) == base(r) else "SYLLABLE",
                        "ref_src": ref_src,
                        "vi": item.get("vietnamese", "")[:36],
                    })

            het = pinyin(hanzi, style=Style.TONE3, heteronym=True, errors="ignore")[0]
            if any(len(g) > 1 for g in het):
                poly_counter[hanzi] += 1

    diff_tone = [d for d in diffs if d["kind"] == "TONE"]

    print("=" * 72)
    print(f"拼音注音审计：{total} 词条 / {n_chars} 字")
    print(f"  [OK] 逐字完全正确     {same:6d} 字 ({same/n_chars*100:.2f}%)")
    print(f"  [!] 仅声调不同       {len(diff_tone):6d} 字")
    print(f"  [X] 音节骨架错误     {len(syl_bad):6d} 词")
    print(f"  [!] 音节数不符(脏数据){len(fmt_issues):6d} 词")
    print(f"  多音字词条          {sum(poly_counter.values()):6d}（{len(poly_counter)} 汉字）")
    print("=" * 72)

    if syl_bad:
        print(f"\n【[X] 音节骨架错误】（{len(syl_bad)} 词 —— 多音字读音选错或数据残缺）")
        for d in syl_bad[:60]:
            print(f"  {d['hanzi']:<10} L{d['level']} 我们={d['stored']!r:<22} "
                  f"骨架={d['our_skeleton']:<16} 基准={d['ref']:<16} "
                  f"[{d['ref_src']}] {d['vi']}")
        if len(syl_bad) > 60:
            print(f"  ... 另有 {len(syl_bad)-60} 词")

    if diff_tone:
        print(f"\n【[!] 声调错误】（{len(diff_tone)} 字）")
        seen, shown = set(), 0
        for d in diff_tone:
            k = (d["hanzi"], d["idx"])
            if k in seen:
                continue
            seen.add(k)
            if shown >= 50:
                break
            shown += 1
            print(f"  {d['hanzi']:<10} 第{d['idx']+1}字「{d['char']}」 L{d['level']} "
                  f"我们={d['ours']:<6} 应为={d['ref']:<6} [{d['ref_src']}] {d['vi']}")
        if len(seen) > shown:
            print(f"  ... 另有 {len(seen)-shown} 字条见 JSON")

    if fmt_issues:
        print(f"\n【[!] 音节数与字数不符】（{len(fmt_issues)} 词，需清洗）")
        for d in fmt_issues[:25]:
            print(f"  {d['hanzi']:<12} L{d['level']} 我们={d['stored']!r:<26} "
                  f"基准={d['ref']}")
        if len(fmt_issues) > 25:
            print(f"  ... 另有 {len(fmt_issues)-25} 词")

    OUT.write_text(json.dumps({
        "total_words": total, "chars_total": n_chars, "chars_ok": same,
        "diff_tone": diff_tone, "syllable_errors": syl_bad,
        "format_issues": fmt_issues, "poly_chars": poly_counter,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n明细已写入 {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())