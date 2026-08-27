#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
except ModuleNotFoundError:  # Pillow is optional when release assets already exist.
    Image = ImageDraw = ImageFilter = None  # type: ignore[assignment]


SIZES = [16, 32, 64, 128, 256, 512, 1024]


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGB", (size, size), top)
    pixels = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        for x in range(size):
            shade = int(12 * math.sin((x / size) * math.pi) * (1 - abs(t - 0.55)))
            pixels[x, y] = tuple(
                max(0, min(255, int(top[i] * (1 - t) + bottom[i] * t) + shade))
                for i in range(3)
            )
    return img.convert("RGBA")


def draw_icon(size: int) -> Image.Image:
    scale = size / 1024
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = rounded_mask(size, int(224 * scale))

    base = gradient(size, (17, 24, 32), (2, 8, 14))
    base.putalpha(mask)
    img.alpha_composite(base)

    draw = ImageDraw.Draw(img)
    inset = int(76 * scale)
    border_w = max(2, int(8 * scale))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.rounded_rectangle(
        (inset, inset, size - inset, size - inset),
        radius=int(176 * scale),
        outline=(33, 226, 196, 120),
        width=max(2, int(10 * scale)),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(max(1, int(16 * scale))))
    img.alpha_composite(glow)
    draw.rounded_rectangle(
        (inset, inset, size - inset, size - inset),
        radius=int(176 * scale),
        outline=(180, 246, 255, 140),
        width=border_w,
    )

    # Two clean lanes: GPT input into local Codex tools.
    left = (int(250 * scale), int(532 * scale))
    mid = (int(512 * scale), int(338 * scale))
    right = (int(774 * scale), int(532 * scale))
    lane_w = max(10, int(42 * scale))
    cyan = (52, 213, 255, 255)
    green = (31, 232, 155, 255)
    ink = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ink_draw = ImageDraw.Draw(ink)
    for width, alpha in [(lane_w * 3, 40), (lane_w * 2, 72), (lane_w, 255)]:
        ink_draw.line([left, mid, right], fill=(49, 226, 208, alpha), width=width, joint="curve")
    img.alpha_composite(ink.filter(ImageFilter.GaussianBlur(max(1, int(3 * scale)))))
    draw.line([left, mid], fill=green, width=lane_w, joint="curve")
    draw.line([mid, right], fill=cyan, width=lane_w, joint="curve")

    # Minimal terminal/code mark.
    mark_w = max(8, int(28 * scale))
    draw.line(
        [
            (int(274 * scale), int(422 * scale)),
            (int(190 * scale), int(512 * scale)),
            (int(274 * scale), int(602 * scale)),
        ],
        fill=(230, 255, 245, 235),
        width=mark_w,
        joint="curve",
    )
    draw.line(
        [
            (int(750 * scale), int(422 * scale)),
            (int(834 * scale), int(512 * scale)),
            (int(750 * scale), int(602 * scale)),
        ],
        fill=(226, 250, 255, 235),
        width=mark_w,
        joint="curve",
    )
    draw.line(
        [(int(432 * scale), int(696 * scale)), (int(592 * scale), int(696 * scale))],
        fill=(219, 255, 251, 230),
        width=max(8, int(24 * scale)),
    )

    # Subtle pixel grid for local workspace signal.
    dot = max(2, int(6 * scale))
    for y in range(235, 790, 80):
        for x in range(235, 790, 80):
            opacity = int(40 + 60 * (x + y) / 1580)
            draw.ellipse(
                (
                    int(x * scale),
                    int(y * scale),
                    int((x + dot) * scale),
                    int((y + dot) * scale),
                ),
                fill=(170, 235, 255, opacity),
            )

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.alpha_composite(img)
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(1, int(9 * scale))))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.alpha_composite(shadow, (0, int(10 * scale)))
    out.alpha_composite(img)
    return out


def draw_status_icon(path: Path, source: Image.Image) -> None:
    source.resize((64, 64), Image.Resampling.LANCZOS).save(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset", default="assets/chatgpt2codex-icon.png")
    parser.add_argument("--out", default="build/macos/generated-icons")
    args = parser.parse_args()

    root = Path.cwd()
    out = root / args.out
    asset_path = root / args.asset
    icns = out / "AppIcon.icns"
    status_path = out / "StatusIconTemplate.png"
    if Image is None:
        if asset_path.exists() and icns.exists() and status_path.exists():
            print("warning: Pillow is not installed; reusing existing macOS icon assets.")
            print(f"wrote {asset_path}")
            print(f"wrote {icns}")
            print(f"wrote {status_path}")
            return
        raise SystemExit(
            "Pillow is required to generate macOS icon assets. Install pillow or keep "
            "assets/chatgpt2codex-icon.png, build/macos/generated-icons/AppIcon.icns, "
            "and build/macos/generated-icons/StatusIconTemplate.png in place."
        )

    iconset = out / "AppIcon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir(parents=True, exist_ok=True)

    base = draw_icon(1024)
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    base.save(asset_path)
    ico_path = asset_path.with_suffix(".ico")
    base.save(
        ico_path,
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    for size in SIZES:
        resized = base.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(iconset / f"icon_{size}x{size}.png")
        if size <= 512:
            retina = base.resize((size * 2, size * 2), Image.Resampling.LANCZOS)
            retina.save(iconset / f"icon_{size}x{size}@2x.png")

    draw_status_icon(status_path, base)

    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns)], check=True)
    print(f"wrote {asset_path}")
    print(f"wrote {ico_path}")
    print(f"wrote {icns}")
    print(f"wrote {status_path}")


if __name__ == "__main__":
    main()
