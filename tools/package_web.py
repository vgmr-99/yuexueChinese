#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
package_web.py — 打包网页版（自动先打内容哈希，再压 zip）

顺序很重要：先 stamp_version.py 重写 index.html 的 ?v=，
再打包。否则 zip 里会是「改了文件但引用还是旧哈希」的版本，
浏览器照样拿不到新内容。
"""
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web"
OUT = ROOT.parent / "deploy" / "athao-web.zip"


def main() -> int:
    r = subprocess.run([sys.executable, str(ROOT / "tools/stamp_version.py")],
                       capture_output=True, text=True, encoding="utf-8")
    print(r.stdout)
    if r.returncode not in (0,):
        print(r.stderr, file=sys.stderr)
        return r.returncode

    OUT.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        for f in sorted(SRC.rglob("*")):
            if f.is_file() and ".git" not in f.parts and f.suffix != ".map":
                z.write(f, f.relative_to(SRC).as_posix())
                n += 1
    print(f"打包完成: {OUT.name}  {n} 文件  {OUT.stat().st_size/1024/1024:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
