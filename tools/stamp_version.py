#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stamp_version.py — 自动给资源引用打上内容哈希

为什么需要
----------
网页版更新源码后，浏览器仍可能长时间用旧缓存。常见原因：
  1. index.html 里手写的 `?v=20260101` 没跟着改（最常见）
  2. 服务器没发 Cache-Control，浏览器按「最后修改时间」启发式缓存，
     结果 js/css 被缓存几小时甚至几天

本脚本把每个被引用的资源按**内容哈希**（sha1 前 8 位）重写引用：
    js/app.js?v=10170756   →   js/app.js?v=a3f5c1d2

于是：
  - 改了某个文件 → 它的哈希变了 → 引用变成新 URL → 浏览器必然重新下载
  - 没改的文件     → 哈希不变 → 仍是同一 URL → 命中缓存，加载飞快

**不需要人工改版本号**，也不需要「每次访问都换新链接」
（后者会让 67MB 的资源每次全量重下，手机流量扛不住）。

用法
----
  python tools/stamp_version.py           # 就地改写 web/index.html
  python tools/stamp_version.py --check   # 只比对，不写（CI 用）
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
INDEX = WEB / "index.html"

# 匹配 href/src 里的本地资源：css / js / png / jpg / woff2 / json
REF = re.compile(r'((?:href|src)=")(?!https?:|data:|//)([^"]+?\.(?:css|js|png|jpe?g|svg|woff2?|json))(\?v=[0-9a-zA-Z_-]*)?"')

# 这些内容稳定、体积大，适合长缓存（配合 .htaccess 的响应头）
LONG_CACHE_EXT = {".png", ".jpg", ".jpeg", ".svg", ".woff2", ".woff", ".ttf"}


def file_hash(p: Path) -> str:
    h = hashlib.sha1()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:8]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查是否最新，不写文件")
    args = ap.parse_args()

    if not INDEX.exists():
        print(f"找不到 {INDEX}", file=sys.stderr)
        return 1

    text = INDEX.read_text(encoding="utf-8")
    changed: list[tuple[str, str, str]] = []   # (相对路径, 旧版本, 新版本)
    missing: list[str] = []

    def repl(m: re.Match) -> str:
        head, path, old_q = m.group(1), m.group(2), m.group(3) or ""
        f = WEB / path
        if not f.exists():
            missing.append(path)
            return m.group(0)
        h = file_hash(f)
        new_q = f"?v={h}"
        if old_q != new_q:
            changed.append((path, old_q or "(无)", new_q))
        return f"{head}{path}{new_q}\""

    new_text = REF.sub(repl, text)

    print(f"扫描 index.html，共处理 {len(REF.findall(text))} 个资源引用")
    if missing:
        print(f"⚠️ 有 {len(missing)} 个引用指向不存在的文件：")
        for p in missing[:8]:
            print(f"   {p}")
        return 2

    if not changed:
        print("✅ 所有资源的哈希都是最新的，无需改动")
    else:
        print(f"需要更新 {len(changed)} 个引用：")
        for p, o, n in changed:
            print(f"   {p:<34} {o:<14} → {n}")
        if not args.check:
            INDEX.write_text(new_text, encoding="utf-8")
            print(f"\n已写入 {INDEX}")
        else:
            print("\n(--check 模式，未写文件)")

    # 汇总一份清单，便于确认「线上到底是哪一版」
    print("\n当前版本清单：")
    for p, _, n in sorted(changed) if changed else []:
        print(f"   {p:<34} {n}")
    total = sum((WEB / p).stat().st_size for p, _, _ in changed) if changed else 0
    if changed:
        print(f"   变更文件合计 {total/1024:.0f} KB")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())