#!/usr/bin/env python3
"""AI-Arch wallpaper generator (procedural, concept phase).

Ported from the original 2a3 generator that produced
profile/layers/32-desktop-theme/assets/wallpaper/ai-arch-wallpaper-1920x1080.png
(original copy kept at /tmp/opencode/gen-wallpaper.py during 2a3).

Parameterized for docs/AI-ARCH-CONCEPT.md §13: higher local contrast so the
glass surfaces (alpha ~0.84) have texture to transmit, while the desktop
stays very dark overall. No external image model — pure numpy/PIL.

Usage:
  python3 gen-wallpaper.py all            # generate every variant
  python3 gen-wallpaper.py v2-balanced    # one variant
  python3 gen-wallpaper.py stats <png>    # print pixel stats for a PNG
"""
import sys
import numpy as np
from PIL import Image, ImageDraw

W, H = 1920, 1080
OUT_DIR = "variants"

# Common structure; each variant tunes contrast knobs only.
BASE = dict(
    falloff=2.2,
    horizon_frac=0.685,
    grid_exp=1.62,
    grid_step=2.4,
    grid_v_lines=14,
    diag_alpha=1.0,      # multiplier on the original diagonal alphas
    vignette=0.22,
)

VARIANTS = {
    "v1-subtle": dict(
        top=(12, 16, 21), bottom=(18, 23, 31),
        cyan=(0.50, 0.60, 950, (16, 66, 78), 0.65),
        violet=(0.16, 0.14, 700, (40, 46, 96), 0.34),
        grid_base=7, grid_ramp=30, grid_v=12,
        vignette=0.18,
    ),
    "v2-balanced": dict(
        top=(13, 17, 23), bottom=(20, 26, 35),
        cyan=(0.50, 0.60, 1000, (16, 66, 78), 0.78),
        violet=(0.16, 0.14, 700, (40, 46, 96), 0.42),
        grid_base=10, grid_ramp=38, grid_v=15,
        diag_alpha=1.4,
        vignette=0.15,
    ),
    "v3-expressive": dict(
        top=(15, 19, 26), bottom=(23, 29, 40),
        cyan=(0.50, 0.60, 1150, (16, 66, 78), 0.82),
        violet=(0.16, 0.14, 700, (40, 46, 96), 0.50),
        grid_base=13, grid_ramp=46, grid_v=18,
        diag_alpha=1.7,
        vignette=0.10,
    ),
}


def glow(img, xx, yy, cx, cy, r, color, strength, falloff):
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / r
    f = np.clip(1 - d, 0, None) ** falloff * strength
    return img + np.stack([f * c for c in color], axis=-1)


def render(p):
    top = np.array(p["top"], dtype=np.float64)
    bot = np.array(p["bottom"], dtype=np.float64)
    t = np.linspace(0, 1, H)[:, None]
    img = top[None, :] * (1 - t) + bot[None, :] * t
    img = np.repeat(img[:, None, :], W, axis=1)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)

    ccx, ccy, cr, ccol, cstr = p["cyan"]
    vvx, vvy, vr, vcol, vstr = p["violet"]
    img = glow(img, xx, yy, W * ccx, H * ccy, cr, ccol, cstr, BASE["falloff"])
    img = glow(img, xx, yy, W * vvx, H * vvy, vr, vcol, vstr, BASE["falloff"])
    img = np.clip(img, 0, 255).astype(np.uint8)

    # --- perspective floor grid (subtle cyan hairlines, distance-faded) ---
    horizon = int(H * BASE["horizon_frac"])
    cx = W // 2
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    y = horizon + 1
    i = 0
    while y < H:
        i += 1
        a = int(p["grid_base"] + p["grid_ramp"] * min(1.0, i / 34))
        gd.line([(0, y), (W, y)], fill=(64, 190, 220, a), width=1)
        y = int(horizon + (i ** BASE["grid_exp"]) * BASE["grid_step"])
    for k in range(-BASE["grid_v_lines"], BASE["grid_v_lines"] + 1):
        gd.line([(cx + k * 7, horizon), (cx + k * 190, H)],
                fill=(64, 190, 220, p["grid_v"]), width=1)

    # distance fade: transparent near the horizon, full at the bottom edge
    fade = np.zeros((H, W), dtype=np.float64)
    rows = np.arange(H)
    fade[rows > horizon] = np.clip((rows[rows > horizon] - horizon) / 90.0, 0, 1)[:, None]
    alpha = np.minimum(np.array(grid.getchannel("A")), (fade * 255).astype(np.uint8))
    grid = Image.merge("RGBA", [grid.getchannel(c) for c in "RGB"] +
                       [Image.fromarray(alpha, "L")])

    canvas = Image.fromarray(img, "RGB").convert("RGBA")
    canvas = Image.alpha_composite(canvas, grid)

    # --- faint architectural diagonals (depth) ---
    dm = p.get("diag_alpha", BASE["diag_alpha"])
    diag = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(diag)
    dd.line([(W * 0.62, 0), (W * 0.86, H)], fill=(200, 210, 220, int(9 * dm)), width=1)
    dd.line([(W * 0.66, 0), (W * 0.88, H)], fill=(200, 210, 220, int(6 * dm)), width=1)
    dd.line([(W * 0.28, 0), (W * 0.10, H)], fill=(200, 210, 220, int(7 * dm)), width=1)
    canvas = Image.alpha_composite(canvas, diag)

    # --- vignette ---
    vy, vx = np.mgrid[0:H, 0:W].astype(np.float64)
    vd = np.sqrt(((vx - W / 2) / (W * 0.72)) ** 2 + ((vy - H / 2) / (H * 0.72)) ** 2)
    vig = np.clip(1 - p["vignette"] * np.clip(vd - 0.55, 0, None) ** 1.5, 0, 1)
    arr = np.array(canvas)[:, :, :3].astype(np.float64) * vig[:, :, None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def stats(path):
    a = np.array(Image.open(path))
    lum = a.mean(axis=2)
    above80 = (lum > 80).mean() * 100
    print(f"{path}: mean {a.mean(axis=(0, 1)).round(1).tolist()} "
          f"lum-mean {lum.mean():.1f} max {lum.max():.0f} "
          f"p99 {np.percentile(lum, 99):.0f} area>80 {above80:.2f}%")


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "all"
    if arg == "stats":
        stats(sys.argv[2])
        return
    names = list(VARIANTS) if arg == "all" else [arg]
    for name in names:
        out = f"{OUT_DIR}/ai-arch-wallpaper-{name}.png"
        img = render(VARIANTS[name])
        img.save(out, "PNG", optimize=True)
        print("saved", out)
        stats(out)


if __name__ == "__main__":
    main()
