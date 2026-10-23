#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_panda_icon.py — 用用户提供的 icons8 熊猫线稿重做图标资源

源图
----
icons8-熊猫-64.png —— 64×64 RGBA，黑色线稿 + 透明背景。
64px 直接放大到 192px 会发糊，本脚本用「8 倍整数放大 → LANCZOS 缩回 →
alpha 锐化」的流程保住线条锐度（线稿的好处是边缘可安全二值化）。

产出
----
1. web/images/logo-panda.png            首页页眉用（192px，白底方块内）
2. drawable/ic_launcher_foreground.xml  自适应图标前景（矢量容器 + 位图内容）
   —— 位图内容以 drawable PNG 形式给出，矢量 drawable 负责留白与定位
3. mipmap-*dpi/ic_launcher.png          旧版圆角方块
4. mipmap-*dpi/ic_launcher_round.png    旧版圆形
5. values/colors.xml                    背景纯白（与首页白底方块一致）
"""
from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = Path("C:/Users/PC/Downloads/icons8-熊猫-64.png")
WEB = ROOT / "web"
RES = ROOT / "android/app/src/main/res"

DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# 自适应图标前景画布 108dp，安全区是中心 66dp 圆；
# 熊猫线稿要留在安全区内 → 内容直径取 60dp
ADAPTIVE_CONTENT_DP = 60.0
CANVAS = 108.0
# 旧版图标内熊猫占比
LEGACY_RATIO = 0.72
RADIUS_RATIO = 0.24
WHITE = (255, 255, 255, 255)
BORDER = (232, 213, 196, 255)


def load_crisp() -> Image.Image:
    """载入源图并做 alpha 锐化，线条不糊"""
    im = Image.open(SRC).convert("RGBA")
    # 8 倍整数放大保住原始像素边界
    big = im.resize((im.width * 8, im.height * 8), Image.NEAREST)
    # 拉回原尺寸（LANCZOS 平滑阶梯）
    smooth = big.resize((im.width * 2, im.height * 2), Image.LANCZOS)
    # alpha 锐化：把中间灰阶推向两端，恢复线稿的硬边
    r, g, b, a = smooth.split()
    a = a.point(lambda v: 0 if v < 90 else (255 if v > 165 else int((v - 90) * 255 / 75)))
    return Image.merge("RGBA", (r, g, b, a))


def fit(inner: Image.Image, size: int) -> Image.Image:
    """把线稿等比放进 size×size 的透明方框"""
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    k = size / inner.width
    art = inner.resize((size, int(inner.height * k)), Image.LANCZOS)
    out.paste(art, (0, (size - art.height) // 2), art)
    return out


def make_legacy(size: int, round_shape: bool, out: Path):
    art = fit(load_crisp(), int(size * LEGACY_RATIO))
    ss = 4
    N = size * ss
    canvas = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    if round_shape:
        d.ellipse((0, 0, N - 1, N - 1), fill=WHITE, outline=BORDER, width=max(1, N // 56))
    else:
        d.rounded_rectangle((0, 0, N - 1, N - 1), radius=int(N * RADIUS_RATIO),
                            fill=WHITE, outline=BORDER, width=max(1, N // 56))
    a = art.resize((int(art.width * ss), int(art.height * ss)), Image.LANCZOS)
    canvas.paste(a, ((N - a.width) // 2, (N - a.height) // 2), a)
    canvas.resize((size, size), Image.LANCZOS).save(out)


def make_adaptive_foreground() -> Path:
    """自适应前景：透明底 + 居中熊猫，由 background 色块补白"""
    # 前景色位图按 108dp 画布出图，内容占 60dp 居中
    size = 432   # 4x of 108dp
    art = fit(load_crisp(), int(size * ADAPTIVE_CONTENT_DP / CANVAS))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(art, ((size - art.width) // 2, (size - art.height) // 2), art)
    p = RES / "drawable/ic_launcher_fg_panda.png"
    canvas.resize((432, 432), Image.LANCZOS).save(p)
    return p


def main() -> int:
    if not SRC.exists():
        raise SystemExit(f"找不到源图：{SRC}")
    base = load_crisp()
    print(f"[源图] {SRC.name} 64x64 → 锐化后 {base.width}x{base.height}")

    # 1) 首页页眉用图
    img_dir = WEB / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    header_png = img_dir / "logo-panda.png"
    fit(base, 192).save(header_png)
    print(f"[页眉] web/images/logo-panda.png 192px  {header_png.stat().st_size}B")

    # 2) 自适应前景
    fg = make_adaptive_foreground()
    print(f"[自适应] {fg.relative_to(RES)} 432px（内容占 {ADAPTIVE_CONTENT_DP}dp，安全区内）")

    # 3) 背景色纯白
    (RES / "values/colors.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        '    <!-- 与首页 .logo-icon 同款白底 -->\n'
        '    <color name="ic_launcher_background">#FFFFFF</color>\n'
        '</resources>\n', encoding="utf-8")
    print("[颜色] 背景 #FFFFFF")

    # 4) 旧版 PNG
    for dens, n in DENSITIES.items():
        d = RES / f"mipmap-{dens}"
        d.mkdir(parents=True, exist_ok=True)
        make_legacy(n, False, d / "ic_launcher.png")
        make_legacy(n, True, d / "ic_launcher_round.png")
        print(f"[PNG] mipmap-{dens:<7} {n}x{n}")

    # 5) 自适应声明（前景换成位图，删掉旧的矢量中字引用）
    (RES / "mipmap-anydpi-v26/ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@drawable/ic_launcher_fg_panda" />\n'
        '</adaptive-icon>\n', encoding="utf-8")
    print("[自适应] ic_launcher.xml 已切到熊猫前景")

    # 6) 清理不再使用的矢量「中」资源，避免残留混淆
    for old in ("drawable/ic_launcher_foreground.xml", "drawable/ic_launcher_monochrome.xml"):
        f = RES / old
        if f.exists():
            f.unlink()
            print(f"[清理] 删除 {old}（已不再被引用）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())