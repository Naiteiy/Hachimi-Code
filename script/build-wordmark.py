#!/usr/bin/env python3
"""Build the block-letter wordmark from a hand-encoded pixel font.

Rendering an outline font and thresholding it produced stray single pixels and
broken half-block fragments, because antialiased strokes land on sub-pixel
boundaries. A 5x7 dot-matrix font has no sub-pixel geometry: every stroke is a
whole pixel, and each pixel is drawn as an upper half block so that it stays
square (a terminal cell is roughly twice as tall as it is wide).

  python3 script/build-wordmark.py              # rewrite the consumers
  python3 script/build-wordmark.py --scale 2    # double the pixel size
  python3 script/build-wordmark.py --preview    # print without writing
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re

# 5 wide x 7 tall, uppercase, one character per pixel. Strokes are exactly one
# pixel so the result stays crisp at any integer scale.
FONT: dict[str, list[str]] = {
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "I": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
    "M": ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
}

LEFT = "HACHIMI"
RIGHT = "CODE"
GLYPH_WIDTH = 5
GLYPH_HEIGHT = 7
LETTER_GAP = 1
WORD_GAP = 3
# Glyph rows are padded to an even count so each terminal cell can carry a pair
# of dots: a cell holds two vertically stacked square dots, which is what keeps
# pixels square and vertical strokes unbroken.
PADDED_HEIGHT = 8


def dots(word: str, scale: int) -> list[str]:
    """Lay the word out as a dot grid with one character per dot."""
    columns: list[str] = []
    for index, char in enumerate(word):
        if index:
            columns.extend([" " * GLYPH_HEIGHT] * LETTER_GAP)
        glyph = FONT[char]
        columns.extend("".join(glyph[row][column] for row in range(GLYPH_HEIGHT)) for column in range(GLYPH_WIDTH))

    grid: list[str] = []
    for row in range(GLYPH_HEIGHT * scale):
        line = ""
        for column in columns:
            line += ("#" if column[row // scale] == "#" else " ") * scale
        grid.append(line)
    blank = " " * len(grid[0])
    while len(grid) % 2:
        grid.append(blank)
    return grid


def render(word: str, scale: int) -> list[str]:
    """Fold dot pairs into cells: both dots solid, a lone dot becomes a half block."""
    grid = dots(word, scale)
    rows: list[str] = []
    for y in range(0, len(grid), 2):
        top, bottom = grid[y], grid[y + 1]
        line = ""
        for x in range(len(top)):
            up, down = top[x] == "#", bottom[x] == "#"
            line += "█" if up and down else "▀" if up else "▄" if down else " "
        rows.append(line)
    return rows


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


def write_consumers(plain: list[str], gap: int) -> None:
    """Keep the CLI banner, the TTY gap, the home logo and the pulse in step."""
    ui = pathlib.Path("packages/opencode/src/cli/ui.ts")
    text = ui.read_text()
    block = "const wordmark = [\n" + "".join(f"  `{row}`,\n" for row in plain) + "]"
    text = re.sub(r"const wordmark = \[.*?\n\]", block, text, flags=re.S)
    text = re.sub(r'const gap = " *"', f'const gap = "{" " * gap}"', text)
    ui.write_text(text)

    home = pathlib.Path("packages/tui/src/component/logo.tsx")
    home.write_text(re.sub(r"gap=\{\d+\}", f"gap={{{gap}}}", home.read_text(), count=1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scale", type=int, default=1, help="pixels per font dot (default 1)")
    parser.add_argument("--gap", type=int, default=WORD_GAP, help="blank cells between the two halves")
    parser.add_argument("--preview", action="store_true", help="print the result and exit")
    args = parser.parse_args()

    left = render(LEFT, args.scale)
    right = render(RIGHT, args.scale)
    width = len(left[0]) + args.gap + len(right[0])

    if args.preview:
        for l, r in zip(left, right):
            print("   " + l + " " * args.gap + r)
        print(f"\n   {len(left)} rows, {len(left[0])} + {args.gap} + {len(right[0])} = {width} columns")
        return

    plain = [f"{l}{' ' * args.gap}{r}" for l, r in zip(left, right)]
    write_tui(left, right)
    write_consumers(plain, args.gap)
    print(f"wordmark rebuilt: {len(left)} rows, {width} columns (scale {args.scale})")
    for row in plain:
        print("   " + row)


if __name__ == "__main__":
    main()
