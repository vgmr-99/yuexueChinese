#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_pinyin.py — 修正词库中的错误注音 + 清洗脏格式

依据：tools/audit_pinyin.py 审计 + 逐条核对越南语/英文释义确认义项。

两类处理
--------
1. 读音选错（多音字默认义项与释义不符）→ FIX_READING
2. 仅格式脏（含括号补充说明 / 双写），主读音正确 → STRIP_PAREN

已核实**无需改动**的条目（义项与读音一致，勿误改）：
  重 chóng(lặp lại) 行 háng(hàng) 了 liǎo(hoàn thành) 着 zháo(nước đi)
  佛 fó(Phật) 觉 jiào(giấc ngủ) 力 lì(họ) 地 de(trợ từ) 家 jiā 熟 shú 化 huà
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOCAB = ROOT / "data" / "vocab.json"

# 1) 读音选错 → 正确读音（带调）
FIX_READING = {
    "还": "hái",        # vi=họ(还) 非 huán
    "长": "cháng",      # vi=chiều dài；dài
    "调": "diào",      # vi=điều chuyển；di chuyển
    "血": "xuè",        # vi=máu
    "得": "dé",        # vi=được；nhận
    "系": "xì",        # vi=kết nối；liên quan đến
    "落": "luò",        # vi=bỏ sót；bị thiếu
    "弹": "dàn",        # vi=đạn；viên đạn
    "吓": "hè",        # vi=dọa；dọa dẫm
    "露": "lù",        # vi=họ（姓氏 Lù）
    "头": "tóu",        # vi=đầu；kiểu tóc
    "谁": "shuí",      # 双写清洗，教材标准读音
}

# 2) 去掉括号补充说明，保留主读音
STRIP_PAREN = {
    "第", "们", "子", "家", "老", "小", "初", "化", "性", "员",
    "者", "品", "界", "族", "熟",
}


def clean_parens(py: str) -> str | None:
    """'dì (dì-èr)' -> 'dì'；'xìng(jījíxìng)' -> 'xìng'"""
    m = re.match(r"^\s*([a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜêế]+\d?)\s*[\(（].*$", py or "")
    return m.group(1) if m else None


def main() -> int:
    data = json.loads(VOCAB.read_text(encoding="utf-8"))
    n_fix = n_strip = 0
    touched = []

    for lvl, words in data["levels"].items():
        for item in words:
            h = item["hanzi"]
            old = item.get("pinyin", "")

            if h in FIX_READING and old != FIX_READING[h]:
                item["pinyin"] = FIX_READING[h]
                n_fix += 1
                touched.append((h, old, FIX_READING[h], f"L{lvl}", "读音修正", item.get("vietnamese", "")[:24]))
                continue

            if h in STRIP_PAREN:
                new = clean_parens(old)
                if new and new != old:
                    item["pinyin"] = new
                    n_strip += 1
                    touched.append((h, old, new, f"L{lvl}", "格式清洗", item.get("vietnamese", "")[:24]))

    VOCAB.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"读音修正 {n_fix} 条，格式清洗 {n_strip} 条")
    print("-" * 78)
    for h, o, n, lv, kind, vi in touched:
        print(f"  {h:<6} {lv:<4} {kind:<6} {o!r:<22} -> {n!r:<10} {vi}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())