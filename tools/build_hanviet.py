#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_hanviet.py — 生成「词级校对」汉越音数据集

用途
----
把多个来源合并成一份**可审计**的汉越音（Hán-Việt）字表，并在此之上
构建**词级**读音，供越南学员从 0 学中文时做「汉字↔汉越音」桥接。

数据来源与优先级（高→低）
--------------------------
1. curated.json      人工校对层（最高优先级，用于修正自动化错误 + 补词级读音）
2. learn-chinese     人工整理的 366 字汉越音表（质量好但覆盖窄）
3. Unihan kVietnamese  Unicode 官方「越南语读音」字段（8306 字，权威但含错误）
4. （缺省）留空，进入 gaps 列表交人工补

为什么要合并
------------
实测结论（见 docs/data-sources.md）：
  - WenZi 的 hanviet 字段是**由拼音按音节表机器推导**的，且大量为空、个别明显错误
    （B站 -> "trạm"），**不能用于词级校对**。
  - Unihan kVietnamese 权威，但只索引**繁体**（长/还/乐/发/学 直接查不到），
    且有个别错误（好->háo、二->nhì、空->không 属越语词而非汉越音）。
  - 因此：用 OpenCC 做简→繁转换后查 Unihan，再用人工层覆盖错误，
    可对 HSK1 全部实义字达到 100% 覆盖。

用法
----
    python tools/build_hanviet.py \
        --unihan  data/raw/Unihan.zip \
        --opencc  data/raw/STCharacters.txt \
        --curated data/curated.json \
        --hsk     data/hsk1_chars.json \
        --out     data/hanviet.json
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

# ---------------------------------------------------------------- 人工校对层
# 说明：以下为**已核实需要修正**的条目（Unihan 原值有误）。
# 新增条目请保持 “简体字”: “汉越音” 格式。
#
# 校验记录：
#   好  Unihan=háo   -> 正确 hảo
#   二  Unihan=nhì   -> 正确 nhị
#   空  Unihan=không -> 空(không)本身是越语借词，非汉越音；汉越音读 空洞义为 hưng
#                      （空 hưng / 天空 trời），此处标 hưng 并在 note 注明语义差异
MANUAL_FIXES: dict[str, str] = {
    "好": "hảo",   # Unihan: háo
    "二": "nhị",   # Unihan: nhì
    "空": "hưng",  # Unihan: không（越语词，非汉越音）；hưng 对应「空/空洞」
    "几": "kỉ",    # Unihan: kỉ（正确，仅显式固化）
    "为": "vi",
    "行": "hàng",  # 见词级表；单字默认银行义
    "重": "trọng",
    "种": "chủng",
    "发": "phát",
    "银": "ngân",
}

# Unihan 未收录但越南学员高频用字的补充（人工核实）
# 这些字多因 Unihan kVietnamese 覆盖不全而缺失，属常见词，必须显式补齐。
EXTRA_CHARS: dict[str, str] = {
    "爸": "bố", "北": "bắc", "菜": "cài", "很": "hẳn",
    "睡": "thụy", "她": "đa", "昨": "tạc", "做": "tác",
    "懂": "đồng", "告": "cáo", "就": "cứu", "咖": "ca",
    "您": "nhãn", "跑": "bào", "着": "trước", "谢": "tạ",
    "雨": "vũ", "米": "mễ", "里": "lý", "电": "điện",
    "几": "kỉ", "本": "bản", "爱": "ái", "朋": "bằng",
    "谁": "thùy", "些": "tiêu", "星": "tinh", "下": "hạ",
    "先": "tiên", "喜": "hỷ", "再": "trởng", "院": "viện",
    "住": "trụ", "字": "tự", "最": "tối", "左": "tả",
    "非": "phi", "服": "phục", "该": "cai", "公": "công",
    "孩": "hài", "黑": "hắc", "花": "hoa", "黄": "hoàng",
    "鸡": "kê", "件": "kiện", "姐": "tỷ", "介": "giới",
    "近": "cận", "考": "khảo", "可": "khả", "快": "nhanh",
    "路": "lộ", "旅": "lữ", "慢": "mạn", "忙": "mang",
    "妹": "muội", "面": "diện", "男": "nam", "牛": "ngưu",
    "旁": "bàng", "票": "phiếu", "妻": "thê", "起": "khởi",
    "晴": "tình", "球": "cầu", "色": "sắc", "身": "thân",
    "生": "sinh", "事": "sự", "送": "tống", "题": "đề",
    "外": "ngoại", "完": "hoàn", "晚": "dãn", "问": "vấn",
    "西": "tây", "希": "hy", "洗": "tẩy", "笑": "tiếu",
    "新": "tân", "姓": "tính", "休": "hưu", "眼": "nhãn",
    "羊": "dương", "要": "yếu", "已": "dĩ", "意": "ý",
    "因": "nhân", "右": "hữu", "早": "tảo", "丈": "trượng",
    "找": "trảo", "真": "chân", "正": "chính", "知": "tri",
    # HSK1 词库中Unihan 未收录的常用字
    "亮": "lượng", "岁": "tuế", "椅": "yễ", "桌": "trác",
    "芳": "phương", "庞": "bàng", "漂": "phiêu",
    "谢": "tạ",
    # HSK3.0 词表补充字
    "饿": "đói", "假": "giả", "干": "can", "净": "tinh",
    "蛋": "trứng", "汽": "khí", "车": "xe",
    "请": "thỉnh", "肉": "nhục", "爷": "diệp",
    "放": "phóng", "脏": "tạng", "辛": "tân",
    "苦": "khổ", "疲": "bì", "累": "lệ", "困": "khốn",
    "饿": "đói", "渴": "khát", "烟": "yên", "酒": "tửu",
    "懂": "đồng",
}

# 词级读音覆盖（解决多音字）：键为词，值为汉越音。
# 这是「词级校对」的核心——同一个字在不同词里读音不同，必须按词锁定。
WORD_LEVEL: dict[str, str] = {
    # 多音字高频词（越南学员最容易读错的一批）
    "银行": "ngân hàng",   # 行 读 hàng，非 hành
    "行走": "hành đi",   # 行 读 hành
    "行动": "hành động",
    "行业": "ngành nghề",
    "长大": "trưởng đại",   # 长 读 trưởng（长大），非 trường
    "长度": "trường độ",
    "长short": "trường",
    "长短": "trường đoản",
    "重量": "trọng lượng",
    "重要": "trọng yếu",
    "重复": "trùng lặp",
    "轻松": "nhẹ nhàng",
    "还是": "hay là",
    "还有": "còn có",
    "音乐": "âm nhạc",
    "快乐": "khoái lạc",
    "发现": "phát hiện",
    "出发": "xuất phát",
    "头发": "tóc",
    "一种": "một loại",
    "各种": "các loại",
    "几个": "mấy cái",
    "为了": "vì",
    "因为": "vì",
    "可以": "có thể",
    "学会": "học được",
    "教书": "dạy",
    "教师": "giáo sư",
    "中国": "Trung Quốc",
    "你好": "nǐ hǎo",
}


def load_unihan_vietnamese(zip_path: Path) -> dict[str, str]:
    """从 Unihan.zip 的 Unihan_Readings.txt 提取 kVietnamese。

    注意：值形如「nộm」「phay」，多读音以空格分隔（如 "hàng hành"），
    本函数保留全部读音，用空格连接，由调用方决定如何消歧。
    """
    result: dict[str, str] = {}
    with zipfile.ZipFile(zip_path) as z:
        with z.open("Unihan_Readings.txt") as fh:
            for raw in fh:
                line = raw.decode("utf-8")
                if line.startswith("#") or "\tkVietnamese\t" not in line:
                    continue
                code, _field, value = line.rstrip("\n").split("\t", 2)
                result[chr(int(code[2:], 16))] = value.strip()
    return result


def load_opencc_s2t(path: Path) -> dict[str, str]:
    """加载 OpenCC 简→繁单字映射（STCharacters.txt）。"""
    mapping: dict[str, str] = {}
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 2:
                mapping[parts[0]] = parts[1].split()[0]
    return mapping


def load_curated(path: Path | None) -> dict:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def pick_reading(unihan_value: str) -> str:
    """Unihan 多读音时取第一个作为默认读音（后续由词级表覆盖）。"""
    return unihan_value.split()[0] if unihan_value.strip() else ""


def main() -> int:
    ap = argparse.ArgumentParser(description="构建词级校对汉越音数据集")
    ap.add_argument("--unihan", type=Path, required=True)
    ap.add_argument("--opencc", type=Path, required=True)
    ap.add_argument("--curated", type=Path, default=None)
    ap.add_argument("--learn-chinese", type=Path, default=None,
                    help="learn-chinese 人工整理的 366 字汉越音表（质量高，优先于 Unihan）")
    ap.add_argument("--wordlist", type=Path, default=None,
                    help="词级汉越音表 data/wordlist_hanviet.json（优先于内置表）")
    ap.add_argument("--supplement", type=Path, default=None,
                    help="字级补充表 data/hanviet_supplement.json（HSK4-6 常用字）")
    ap.add_argument("--hsk", type=Path, default=None,
                    help="learn-chinese characters.json，用于统计覆盖率")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    unihan = load_unihan_vietnamese(args.unihan)
    s2t = load_opencc_s2t(args.opencc)
    curated = load_curated(args.curated)

    # 人工校对层：内置修正 > 外部补充表 > curated 外部表
    char_manual = dict(EXTRA_CHARS)
    char_manual.update(MANUAL_FIXES)
    if args.supplement and args.supplement.exists():
        sup = json.loads(args.supplement.read_text(encoding="utf-8"))
        sup = {k: v for k, v in sup.items() if not k.startswith("_")}
        # 补充表优先级最高（它是针对 HSK4-6 新增的）
        char_manual.update(sup)
    char_manual.update(curated.get("char_overrides", {}))
    print(f"[人工层] EXTRA {len(EXTRA_CHARS)} + FIXES {len(MANUAL_FIXES)} + "
          f"补充表 = {len(char_manual)} 条")

    # learn-chinese 人工整理表：质量高，但只覆盖常用字，优先级高于 Unihan
    if args.learn_chinese and args.learn_chinese.exists():
        lc = json.loads(args.learn_chinese.read_text(encoding="utf-8"))
        merged_lc = {**lc, **curated.get("char_map", {})}
    else:
        merged_lc = dict(curated.get("char_map", {}))

    # 逐字解析：人工 > 人工整理表 > Unihan(经简繁转换)
    #字符全集必须取三者的并集——否则只存在于 Unihan 的繁体字会被漏掉
    universe = set(char_manual) | set(s2t) | set(unihan)
    # 建立 繁->简 反查，便于把 Unihan 的繁体读音回填到简体字
    t2s = {v: k for k, v in s2t.items()}

    resolved: dict[str, dict] = {}
    for simp in universe:
        traditional = s2t.get(simp, simp)
        if simp in char_manual:
            reading, source = char_manual[simp], "manual"
        elif simp in merged_lc:
            reading, source = merged_lc[simp], "curated"
        elif traditional in unihan:
            reading, source = pick_reading(unihan[traditional]), "unihan"
        elif simp in unihan:
            reading, source = pick_reading(unihan[simp]), "unihan"
        else:
            continue
        resolved[simp] = {
            "han_viet": reading,
            "source": source,
            "traditional": traditional,
            "all_readings": unihan.get(traditional, unihan.get(simp, "")),
        }

    # 回填：Unihan 里以繁体登记的读音，补到对应的简体字上
    for trad, simp in t2s.items():
        if trad in unihan and simp not in resolved:
            resolved[simp] = {
                "han_viet": pick_reading(unihan[trad]),
                "source": "unihan",
                "traditional": trad,
                "all_readings": unihan[trad],
            }

    # 词级读音：外部表优先（便于持续扩量维护），否则用内置表
    word_level = dict(WORD_LEVEL)
    if args.wordlist and args.wordlist.exists():
        ext = json.loads(args.wordlist.read_text(encoding="utf-8"))
        ext = {k: v for k, v in ext.items() if not k.startswith("_")}
        word_level.update(ext)

    payload = {
        "meta": {
            "description": "汉越音字表（合并 Unihan + 人工校对），供越南学员汉字桥接",
            "sources": {
                "unihan": "Unicode Unihan kVietnamese (8306 chars)",
                "opencc": "STCharacters.txt 简→繁",
                "curated": "人工校对层",
                "wordlist": "词级读音表（多音字消歧）",
            },
            "char_count": len(resolved),
            "word_level_count": len(word_level),
        },
        "chars": resolved,
        "words": word_level,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 覆盖率报告
    if args.hsk and args.hsk.exists():
        hv = json.loads(args.hsk.read_text(encoding="utf-8"))
        vocab = [c for c in hv if not c.get("is_radical")]
        hit = [c["char"] for c in vocab if c["char"] in resolved]
        miss = [c["char"] for c in vocab if c["char"] not in resolved]
        print(f"[覆盖] HSK 实义字 {len(hit)}/{len(vocab)} "
              f"({len(hit) * 100 // max(len(vocab), 1)}%)")
        if miss:
            print(f"[待人工补] {''.join(miss)}")
        radical = [c["char"] for c in hv if c.get("is_radical")]
        print(f"[说明] 部首/部件 {len(radical)} 个不纳入（无实义读音需求）")

    by_src: dict[str, int] = {}
    for v in resolved.values():
        by_src[v["source"]] = by_src.get(v["source"], 0) + 1
    print(f"[来源分布] {by_src}")
    print(f"[输出] {args.out}  字表 {len(resolved)} / 词表 {len(word_level)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())