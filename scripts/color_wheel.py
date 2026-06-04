#!/usr/bin/env python3
"""MeteoNight カラートークンの色相図を生成する。

src/styles/index.css の :root にある生の色トークン（--rgb-*）を自動で読み取り、
各色を HSL へ変換して極座標（角度 = 色相 / 半径 = 明度 L、彩度は非エンコード）へ
配置した散布図を docs/color-tokens-hsl.png として書き出す。

別名トークン（--btn-* / --ctrl-*）は生色を rgb(var(--rgb-*)) で参照するだけなので
ここでは描画しない（--rgb-* のみが対象）。色を編集したらこのスクリプトを再実行して
図を更新すること。値はハードコードせず常に index.css から読むため、両者が乖離しない。

依存: Pillow（pip install Pillow）
実行: python3 -u scripts/color_wheel.py
"""
import sys
import re
import math
import colorsys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(line_buffering=True)

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "src" / "styles" / "index.css"
OUT = ROOT / "docs" / "color-tokens-hsl.png"

SS = 2  # supersampling
W, H = 2400 * SS, 2200 * SS
cx, cy = 1200 * SS, 1070 * SS
R = 720 * SS


def load_tokens():
    """:root の `--rgb-NAME: R, G, B;` を定義順に [(name, (r, g, b)), ...] で返す。

    接頭辞 rgb- はラベルを短くするため落とす（black / card-red / crest-panel-core …）。
    """
    text = CSS.read_text(encoding="utf-8")
    # 最初の :root { ... } ブロックに限定（他所の同名定義に引きずられないため）。
    # :root 内に } を含む宣言は無いので、最初の } までで正しく閉じる。
    m = re.search(r":root\s*\{(.*?)\}", text, re.S)
    block = m.group(1) if m else text
    out = []
    for mt in re.finditer(
        r"--(rgb-[a-z0-9-]+)\s*:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", block
    ):
        name = mt.group(1)[len("rgb-"):]
        rgb = (int(mt.group(2)), int(mt.group(3)), int(mt.group(4)))
        out.append((name, rgb))
    if not out:
        sys.exit(f"色トークン（--rgb-*）が見つかりません: {CSS}")
    return out


def to_hls(rgb):
    r, g, b = [v / 255 for v in rgb]
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return h * 360, l * 100, s


def lum(rgb):
    r, g, b = [v / 255 for v in rgb]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _load_font(candidates, sz):
    for p in candidates:
        try:
            return ImageFont.truetype(p, sz)
        except OSError:
            continue
    return ImageFont.load_default()


def font(sz):
    return _load_font(
        ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVuSans.ttf"], sz
    )


def fontb(sz):
    return _load_font(
        ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVuSans-Bold.ttf"],
        sz,
    )


def polar(hue, L):
    ang = math.radians(hue - 90)  # hue=0 -> up (12 o'clock), clockwise
    r = (L / 100) * R
    return cx + r * math.cos(ang), cy + r * math.sin(ang)


colors = load_tokens()

img = Image.new("RGB", (W, H), (58, 58, 62))
d = ImageDraw.Draw(img)
grid = (96, 96, 102)

# ---- lightness rings ----
for L in (20, 40, 60, 80, 100):
    rr = (L / 100) * R
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=grid, width=1 * SS)
# L tick labels placed along the sparse 198° spoke (lower-left, few points)
for L in (20, 40, 60, 80, 100):
    lx, ly = polar(198, L)
    d.text((lx, ly), f"L={L}", font=font(15 * SS), fill=(150, 150, 156),
           anchor="mm", stroke_width=3 * SS, stroke_fill=(45, 45, 49))
d.ellipse([cx - 3 * SS, cy - 3 * SS, cx + 3 * SS, cy + 3 * SS], fill=grid)

# ---- hue spokes + outer labels ----
for hd in range(0, 360, 30):
    x, y = polar(hd, 100)
    d.line([cx, cy, x, y], fill=grid, width=1 * SS)
huenames = {0: "0° red", 60: "60° yellow", 120: "120° green",
            180: "180° cyan", 240: "240° blue", 300: "300° magenta"}
for hd, nm in huenames.items():
    ang = math.radians(hd - 90)
    lx = cx + (R + 30 * SS) * math.cos(ang)
    ly = cy + (R + 30 * SS) * math.sin(ang)
    co = math.cos(ang)
    ha = "lm" if co > 0.3 else ("rm" if co < -0.3 else "mm")
    d.text((lx, ly), nm, font=font(17 * SS), fill=(180, 180, 192), anchor=ha,
           stroke_width=3 * SS, stroke_fill=(40, 40, 44))

# ---- compute point positions ----
P = []
for name, rgb in colors:
    hue, L, s = to_hls(rgb)
    x, y = polar(hue, L)
    P.append({"name": name, "rgb": rgb, "x": x, "y": y})

# ---- points ----
rad = 11 * SS
for p in P:
    x, y, rgb = p["x"], p["y"], p["rgb"]
    edge = (255, 255, 255) if lum(rgb) < 0.5 else (28, 28, 30)
    d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=rgb, outline=edge, width=2 * SS)

# ---- labels next to each dot; small font, hyphens→newlines, greedy de-overlap ----
fnt = font(12 * SS)
LSP = -3 * SS  # 行間（負で詰める）
placed = []


def hits(box, others):
    for o in others:
        if not (box[2] < o[0] or box[0] > o[2] or box[3] < o[1] or box[1] > o[3]):
            return True
    return False


def measure(xy, txt, anchor, align):
    b = d.textbbox(xy, txt, font=fnt, anchor=anchor, align=align, spacing=LSP)
    return (b[0] - 3 * SS, b[1] - 2 * SS, b[2] + 3 * SS, b[3] + 2 * SS)


# 点そのものもラベル回避の対象に加える（ラベルが別の点へ重ならないように）
placed.extend([(pp["x"] - rad, pp["y"] - rad, pp["x"] + rad, pp["y"] + rad) for pp in P])

# 放射方向(0)を起点に ±15° 刻みで全方位へ広げる角度リスト
ANGLE_STEPS = [0.0]
for _k in range(1, 13):
    ANGLE_STEPS += [_k * math.pi / 12, -_k * math.pi / 12]

# 外周（余白の多い点）から先に置くと、密集部のラベルが空きへ逃げやすい。
# 放射方向・近距離を優先し、空かなければ角度を全方位へ広げ、さらに距離を伸ばして探す。
for p in sorted(P, key=lambda q: -math.hypot(q["x"] - cx, q["y"] - cy)):
    label = p["name"].replace("-", "\n")  # ハイフン区切りを改行に
    base = math.radians(to_hls(p["rgb"])[0] - 90)
    chosen = None
    for dist in range(rad + 9 * SS, 340 * SS, 5 * SS):
        for da in ANGLE_STEPS:
            a = base + da
            ox, oy = math.cos(a), math.sin(a)
            lx = p["x"] + ox * dist
            ly = p["y"] + oy * dist
            ha = "lm" if ox > 0.25 else ("rm" if ox < -0.25 else "mm")
            align = "left" if ha == "lm" else ("right" if ha == "rm" else "center")
            box = measure((lx, ly), label, ha, align)
            # 画像端・上部タイトル・下部の注釈帯を避ける
            if box[0] < 8 * SS or box[2] > W - 8 * SS or box[1] < 72 * SS or box[3] > 1860 * SS:
                continue
            if not hits(box, placed):
                chosen = (lx, ly, ha, align, box, a)
                break
        if chosen:
            break
    if not chosen:  # どうしても空かなければ放射方向の至近へ
        a = base
        ox, oy = math.cos(a), math.sin(a)
        lx, ly = p["x"] + ox * (rad + 9 * SS), p["y"] + oy * (rad + 9 * SS)
        ha = "lm" if ox > 0.25 else ("rm" if ox < -0.25 else "mm")
        align = "left" if ha == "lm" else ("right" if ha == "rm" else "center")
        box = measure((lx, ly), label, ha, align)
        chosen = (lx, ly, ha, align, box, a)
    lx, ly, ha, align, box, a = chosen
    placed.append(box)
    if math.hypot(lx - p["x"], ly - p["y"]) - rad > 16 * SS:  # 離れたら引き出し線
        d.line([p["x"] + math.cos(a) * rad, p["y"] + math.sin(a) * rad, lx, ly],
               fill=(110, 110, 118), width=1 * SS)
    d.text((lx, ly), label, font=fnt, fill=(246, 246, 246), anchor=ha, align=align,
           spacing=LSP, stroke_width=3 * SS, stroke_fill=(22, 22, 25))

# ---- title + notes ----
d.text((W // 2, 32 * SS), "MeteoNight color tokens  —  Hue (angle) × Lightness (radius)",
       font=fontb(30 * SS), fill=(236, 236, 242), anchor="ma")
notes = [
    "Angle = Hue (top = 0° red, clockwise).    Radius = Lightness L (HSL).    Saturation is NOT encoded.",
    "White / Black have S=0 (no hue), placed at 0° by convention; grayish tokens use their computed hue.",
    "Source: src/styles/index.css :root (--rgb-* tokens). Aliases (--btn-*/--ctrl-*) reference these, not plotted.",
]
ny = 1900 * SS
for i, t in enumerate(notes):
    d.text((58 * SS, ny + i * 30 * SS), t, font=font(18 * SS), fill=(200, 200, 206), anchor="la")

img = img.resize((W // SS, H // SS), Image.LANCZOS)
OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT)
print(f"saved {OUT} {img.size}  ({len(colors)} tokens)")
