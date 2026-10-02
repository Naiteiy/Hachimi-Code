#!/usr/bin/env python3
"""Rebuild the block-letter wordmark from a real font.

Hand-drawing glyphs at this size produced unreadable shapes, so the wordmark is
generated instead: the text is rendered with a system font at high resolution,
downsampled to a small pixel grid, thresholded, and mapped onto block
characters. Each cell carries two vertically stacked pixels, which is why the
renderer draws them with upper/lower half blocks.

  python3 script/build-wordmark.py                    # rewrite both consumers
  python3 script/build-wordmark.py --preview          # print candidates only

Widths are chosen so the result fits an 80 column terminal. Uppercase is used
because capitals hold up far better than lowercase at this pixel size.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re

from PIL import Image, ImageDraw, ImageFont

NARROW_BOLD = "/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf"
ARIAL_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

# The two halves are rendered separately so the renderer can tint them apart.
LEFT = "HACHIMI"
RIGHT = "CODE"
GAP = 3


def render(text: str, font_path: str, height: int, threshold: int) -> Image.Image:
    size = 400
    font = ImageFont.truetype(font_path, size)
    canvas = Image.new("L", (size * len(text) * 2, size * 2), 0)
    ImageDraw.Draw(canvas).text((size // 2, size // 2), text, font=font, fill=255)
    glyphs = canvas.crop(canvas.getbbox())
    width = max(1, round(glyphs.width * height / glyphs.height))
    small = glyphs.resize((width, height), Image.LANCZOS)
    return small.point(lambda value: 255 if value >= threshold else 0)


def to_rows(bitmap: Image.Image) -> list[str]:
    """One cell = 1px wide x 2px tall -> full block, top half, bottom half, blank."""
    px = bitmap.load()
    rows = []
    for y in range(0, bitmap.height, 2):
        line = ""
        for x in range(bitmap.width):
            top = px[x, y] > 0
            bottom = y + 1 < bitmap.height and px[x, y + 1] > 0
            line += "█" if top and bottom else "▀" if top else "▄" if bottom else " "
        rows.append(line)
    return rows


def build(font_path: str, height: int, threshold: int, gap: int) -> tuple[list[str], list[str], list[str]]:
    left = to_rows(render(LEFT, font_path, height, threshold))
    right = to_rows(render(RIGHT, font_path, height, threshold))
    plain = [f"{l}{' ' * gap}{r}".replace("_", " ") for l, r in zip(left, right)]
    return left, right, plain


def write_tui(left: list[str], right: list[str]) -> None:
    path = pathlib.Path("packages/tui/src/logo.ts")
    path.write_text(
        "export const logo = {\n"
        f"  left: {json.dumps(left, ensure_ascii=False)},\n"
        f"  right: {json.dumps(right, ensure_ascii=False)},\n"
        "}\n\n"
        "export const go = {\n"
        '  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],\n'
        '  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],\n'
        "}\n\n"
        'export const marks = "_^~,"\n'
    )


def write_cli(plain: list[str], gap: int) -> None:
    """Keep the non-TTY banner and the TTY gap in step with the shared art."""
    path = pathlib.Path("packages/opencode/src/cli/ui.ts")
    text = path.read_text()
    block = "const wordmark = [\n" + "".join(f"  `{row}`,\n" for row in plain) + "]"
    path.write_text(re.sub(r"const wordmark = \[.*?\n\]", block, text, flags=re.S))

    banner = pathlib.Path("packages/tui/src/component/bg-pulse-render.ts")
    banner.write_text(re.sub(r"const LOGO_GAP = \d+", f"const LOGO_GAP = {gap}", banner.read_text()))

    home = pathlib.Path("packages/tui/src/component/logo.tsx")
    home.write_text(re.sub(r"gap=\{\d+\}", f"gap={{{gap}}}", home.read_text(), count=1))

    ui = pathlib.Path("packages/opencode/src/cli/ui.ts")
    ui.write_text(re.sub(r'const gap = " +"', f'const gap = "{" " * gap}"', ui.read_text()))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--height", type=int, default=8, help="cap height in pixels (default 8)")
    parser.add_argument("--threshold", type=int, default=150, help="binarisation threshold (default 150)")
    parser.add_argument("--gap", type=int, default=GAP, help="blank columns between the halves")
    parser.add_argument("--font", default=NARROW_BOLD, help="font file to render with")
    parser.add_argument("--preview", action="store_true", help="print candidates and exit")
    args = parser.parse_args()

    if args.preview:
        for label, font in (("narrow-bold", NARROW_BOLD), ("arial-bold", ARIAL_BOLD)):
            left, right, _ = build(font, args.height, args.threshold, args.gap)
            print(f"\n--- {label}: {len(left[0])}+{args.gap}+{len(right[0])} = {len(left[0]) + args.gap + len(right[0])} cols")
            for row in left + right:
                print("   " + row)
        return

    left, right, plain = build(args.font, args.height, args.threshold, args.gap)
    write_tui(left, right)
    write_cli(plain, args.gap)

    print(f"wordmark rebuilt: {len(left[0])} + {args.gap} + {len(right[0])} = {len(left[0]) + args.gap + len(right[0])} cols, {len(left)} rows")
    for row in plain:
        print("   " + row.replace("█", "█"))


if __name__ == "__main__":
    main()
