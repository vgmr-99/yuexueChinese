#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_launcher_icon.py — 用首页同款「白底 + 红中」重做桌面图标

背景
----
用户决定沿用 App 首页那个「中」标记（.logo-icon：白底圆角方块 + 朱红「中」），
不再另画图案。桌面名称同步改为「越学中文」。

本脚本产出
----------
1. drawable/ic_launcher_foreground.xml   自适应图标前景（矢量，108dp 画布）
2. drawable/ic_launcher_monochrome.xml   Android 13+ 主题图标层
3. values/colors.xml                    背景色改为纯白
4. mipmap-*dpi/ic_launcher.png          旧版圆角方块图标（原本缺失）
5. mipmap-*dpi/ic_launcher_round.png    旧版圆形图标
6. values/strings.xml                   app_name → 越学中文

「中」字轮廓用 fontTools 从系统字体（微软雅黑）真实提取，
而不是手画近似 —— 保证字形规范、任意尺寸都锐利。
"""
from __future__ import annotations

from pathlib import Path

from fontTools.misc.transform import Transform
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTCollection, TTFont
from PIL import Image, ImageDraw, ImageFont

RES = Path(__file__).resolve().parent.parent / "android/app/src/main/res"
FONT = "C:/Windows/Fonts/msyh.ttc"

# —— 与 App 内 CSS 保持一致的取色 ——
RED = "#C0392B"          # var(--red)，首页 .logo-icon 的字色
WHITE = "#FFFFFF"        # 首页 .logo-icon 的底色
BORDER = "#E8D5C4"       # var(--border)，浅色描边，让白块在白壁纸上也有轮廓

# 中字在 108dp 画布中的目标高度（自适应图标安全区是中心 66dp 圆）
GLYPH_H_DP = 54.0
CANVAS = 108.0

DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# 圆角方块圆角半径占比（对齐首页 42px 方块的 11px 圆角 ≈ 26%，这里取 24% 视觉更稳）
RADIUS_RATIO = 0.24
# 中字高度占图标边长比例（对齐首页 22.4px / 42px ≈ 53%）
GLYPH_RATIO = 0.53


def load_glyph(ch: str = "中"):
    """返回 (pathData, xMin, yMin, xMax, yMax, upem)"""
    f = TTCollection(FONT).fonts[0] if FONT.endswith(".ttc") else TTFont(FONT)
    cmap = f.getBestCmap()
    upem = f["head"].unitsPerEm
    name = cmap[ord(ch)]
    gs = f.getGlyphSet()
    pen = SVGPathPen(gs, ntos=lambda v: f"{v:.1f}")
    gs[name].draw(pen)
    from fontTools.pens.boundsPen import BoundsPen
    bp = BoundsPen(gs)
    gs[name].draw(bp)
    return pen.getCommands(), bp.bounds, upem


def write_vector(path: Path, color: str, glyph_h: float):
    """写一个把「中」摆到画布正中的矢量 drawable"""
    d, (xmin, ymin, xmax, ymax), _ = load_glyph()
    cx = cy = CANVAS / 2.0
    s = glyph_h / (ymax - ymin)                 # 字形单位 → dp 的缩放
    # 字体 Y 轴向上，Android Y 轴向下 → scaleY 取负并用 translate 补回
    tx = cx - s * (xmin + xmax) / 2.0
    ty = cy + s * (ymin + ymax) / 2.0
    path.write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<!-- 桌面图标前景：朱红「中」，字形取自微软雅黑，随图标尺寸无损缩放 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group
        android:scaleX="{s:.5f}"
        android:scaleY="{-s:.5f}"
        android:translateX="{tx:.3f}"
        android:translateY="{ty:.3f}">
        <path
            android:fillColor="{color}"
            android:pathData="{d}" />
    </group>
</vector>
''', encoding="utf-8")
    return s, tx, ty


def make_png(n: int, round_shape: bool, out: Path):
    """旧版图标：白底 + 朱红中（与首页 .logo-icon 同构）"""
    ss = 4                                     # 4 倍超采样后缩回，小字号更锐利
    N = n * ss
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rgba = tuple(int(WHITE[i:i + 2], 16) for i in (1, 3, 5)) + (255,)
    edge = tuple(int(BORDER[i:i + 2], 16) for i in (1, 3, 5)) + (255,)
    if round_shape:
        d.ellipse((0, 0, N - 1, N - 1), fill=rgba, outline=edge, width=max(1, N // 64))
    else:
        r = int(N * RADIUS_RATIO)
        d.rounded_rectangle((0, 0, N - 1, N - 1), radius=r, fill=rgba,
                            outline=edge, width=max(1, N // 64))
    font = ImageFont.truetype(FONT, int(N * GLYPH_RATIO), index=0)
    red = tuple(int(RED[i:i + 2], 16) for i in (1, 3, 5)) + (255,)
    d.text((N / 2, N / 2), "中", font=font, fill=red, anchor="mm")
    img.resize((n, n), Image.LANCZOS).save(out)
    return out


def main() -> int:
    # 1) 自适应图标前景（红）+ 主题图标层（纯白，交给系统着色）
    fg = RES / "drawable/ic_launcher_foreground.xml"
    s, tx, ty = write_vector(fg, RED, GLYPH_H_DP)
    print(f"[矢量] 前景 scale={s:.4f} translate=({tx:.2f},{ty:.2f}) 字高={GLYPH_H_DP}dp")

    mono = RES / "drawable/ic_launcher_monochrome.xml"
    write_vector(mono, "#FFFFFFFF", GLYPH_H_DP)
    print(f"[矢量] 主题层 {mono.name}")

    # 2) 背景色改纯白（原来是从未采用的青绿 #0F766E）
    (RES / "values/colors.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <!-- 与首页 .logo-icon 同款白底 -->\n'
        f'    <color name="ic_launcher_background">{WHITE}</color>\n'
        '</resources>\n', encoding="utf-8")
    print(f"[颜色] 背景 {WHITE}")

    # 3) 自适应图标声明（补上 monochrome，Android 13+ 桌面支持主题图标）
    (RES / "mipmap-anydpi-v26/ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n'
        '    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />\n'
        '</adaptive-icon>\n', encoding="utf-8")
    print("[自适应] ic_launcher.xml 已补 monochrome 层")

    # 4) 旧版 PNG 兜底（此前项目只有 anydpi-v26，API<26 设备无图标资源）
    for dens, n in DENSITIES.items():
        d = RES / f"mipmap-{dens}"
        d.mkdir(parents=True, exist_ok=True)
        make_png(n, False, d / "ic_launcher.png")
        make_png(n, True, d / "ic_launcher_round.png")
        print(f"[PNG] mipmap-{dens:<7} {n}x{n}  方形 + 圆形")

    # 5) 桌面名称
    (RES / "values/strings.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        '    <string name="app_name">越学中文</string>\n'
        '</resources>\n', encoding="utf-8")
    print("[名称] app_name = 越学中文")

    # 6) 自检：确认中字真的落在画布中央且不越界
    _, (xmin, ymin, xmax, ymax), upem = load_glyph()
    w = (xmax - xmin) / upem * GLYPH_H_DP
    print(f"[自检] 中字实际尺寸 {w:.1f} x {GLYPH_H_DP:.1f} dp"
          f"（安全区直径 66dp，{'[OK] 在安全区内' if w <= 66 and GLYPH_H_DP <= 66 else '[X] 越界'}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())