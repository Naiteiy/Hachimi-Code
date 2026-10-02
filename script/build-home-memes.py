#!/usr/bin/env python3
"""Convert meme images (GIF/PNG) into terminal sprites for the TUI home screen.

`@opentui/core` 0.4.5 has no image renderable, so real pictures cannot be drawn
directly. This script decodes them ahead of time, downsamples each frame to a
small RGBA grid, and emits base64 frames that `home-memes.tsx` paints with
half-block characters (one cell = 1px wide x 2px tall, which keeps pixels square
because terminal cells are roughly twice as tall as they are wide).

Requires Pillow (already installed; else `pip3 install --user pillow`).
Run from the repo root:

  python3 script/build-home-memes.py \
    --out packages/tui/src/component/home-memes/memes.json \
    ../07ccda13.gif ../301358c6.gif ../3fe20408.gif ../f9ceabfd.gif ../PixPin.png

Add `--preview 0` to print an ANSI half-block preview of the first sprite so you
can judge output quality without starting the TUI.
"""

from __future__ import annotations

import argparse
import base64
import json
import os

from PIL import Image, ImageChops, ImageSequence

# Pixels within this luminance distance of the detected background are keyed out.
BG_TOLERANCE = 34


def detect_background(frame: Image.Image) -> tuple[int, int, int] | None:
    """Return a background colour to key out, or None to keep the frame as-is.

    Only solid-frame images (all four corners agree and are opaque) are keyed.
    Cutout art with transparent corners is left untouched.
    """
    w, h = frame.size
    probes = ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))
    if any(frame.getpixel(p)[3] < 255 for p in probes):
        return None
    corners = [frame.getpixel(p)[:3] for p in probes]
    first = corners[0]
    if any(max(abs(a - b) for a, b in zip(corner, first)) > 8 for corner in corners[1:]):
        return None
    return first


def key_out(frame: Image.Image, key: tuple[int, int, int]) -> Image.Image:
    """Zero the alpha of pixels close to the key colour (vectorised in PIL)."""
    distance = ImageChops.difference(frame.convert("RGB"), Image.new("RGB", frame.size, key)).convert("L")
    mask = distance.point(lambda v: 0 if v <= BG_TOLERANCE else 255)
    out = frame.copy()
    out.putalpha(ImageChops.multiply(frame.getchannel("A"), mask))
    return out


def downsample(image: Image.Image, target: tuple[int, int]) -> Image.Image:
    """Resize using premultiplied alpha.

    Resampling channels independently lets fully transparent neighbours bleed
    their (arbitrary) colour into opaque edge pixels, which shows up as a dark
    halo at these pixel sizes. Premultiply -> resize -> unpremultiply avoids it.
    """
    alpha = image.getchannel("A")
    channels = [ImageChops.multiply(channel, alpha) for channel in image.convert("RGB").split()]
    scaled = [channel.resize(target, Image.LANCZOS) for channel in channels]
    scaled_alpha = alpha.resize(target, Image.LANCZOS)
    unpremultiplied = Image.new("RGB", target)
    unpremultiplied.putdata(
        [
            tuple(round(channel * 255 / a) if a else 0 for channel in pixel)
            for pixel, a in zip(zip(*[channel.getdata() for channel in scaled]), scaled_alpha.getdata())
        ]
    )
    return Image.merge("RGBA", (*unpremultiplied.split(), scaled_alpha))


def union_box(frames: list[Image.Image], threshold: int = 8) -> tuple[int, int, int, int] | None:
    """Bounding box covering the visible pixels of every frame.

    Cropping to the shared box (rather than per frame) reclaims the empty margin
    these cutout sprites carry, which at 20px is most of the sprite, while
    keeping the animation from jittering.
    """
    box = None
    for frame in frames:
        found = frame.getchannel("A").point(lambda v: 255 if v > threshold else 0).getbbox()
        if found is None:
            continue
        box = found if box is None else (
            min(box[0], found[0]),
            min(box[1], found[1]),
            max(box[2], found[2]),
            max(box[3], found[3]),
        )
    return box


def fit(frame: Image.Image, box: tuple[int, int, int, int], size: int) -> Image.Image:
    """Crop to box, scale to fit size x size preserving aspect, centre on a transparent canvas."""
    cropped = frame.crop(box)
    ratio = min(size / cropped.width, size / cropped.height)
    target = (max(1, round(cropped.width * ratio)), max(1, round(cropped.height * ratio)))
    sprite = downsample(cropped, target)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(sprite, ((size - target[0]) // 2, (size - target[1]) // 2))
    return canvas


def decode(path: str) -> tuple[list[Image.Image], list[int]]:
    """Decode every frame as keyed RGBA plus its display duration."""
    image = Image.open(path)
    frames: list[Image.Image] = []
    durations: list[int] = []
    for frame in ImageSequence.Iterator(image):
        rgba = frame.convert("RGBA")
        background = detect_background(rgba)
        if background is not None:
            rgba = key_out(rgba, background)
        duration = frame.info.get("duration") or image.info.get("duration") or 60
        frames.append(rgba)
        durations.append(max(20, int(duration)))
    image.close()
    if not frames:
        raise SystemExit(f"{path}: no frames decoded")
    return frames, durations


def encode(frames: list[Image.Image], durations: list[int], size: int) -> list[tuple[str, int]]:
    box = union_box(frames) or (0, 0, frames[0].width, frames[0].height)
    return [(base64.b64encode(fit(frame, box, size).tobytes()).decode("ascii"), ms) for frame, ms in zip(frames, durations)]


def thin(frames: list[tuple[str, int]], max_frames: int) -> list[tuple[str, int]]:
    """Evenly sample frames down to max_frames, merging the skipped durations.

    Summing the durations of each merged group keeps the loop length (and so the
    animation speed) identical to the source.
    """
    if max_frames <= 0 or len(frames) <= max_frames:
        return frames
    step = len(frames) / max_frames
    out: list[tuple[str, int]] = []
    for index in range(max_frames):
        group = frames[int(index * step) : max(int(index * step) + 1, int((index + 1) * step))]
        out.append((group[len(group) // 2][0], sum(duration for _, duration in group)))
    return out


def preview(sprite: dict, size: int, background: tuple[int, int, int] = (0x17, 0x0F, 0x07)) -> None:
    """Print one frame as ANSI half blocks, composited over the theme background."""
    frame = base64.b64decode(sprite["frames"][len(sprite["frames"]) // 2]["px"])

    def blend(index: int) -> tuple[int, int, int]:
        r, g, b, a = frame[index * 4 : index * 4 + 4]
        t = a / 255
        return tuple(round(c * t + back * (1 - t)) for c, back in zip((r, g, b), background))

    print(f"\n  {sprite['name']}  ({len(sprite['frames'])} frames, {size}x{size} px)")
    for y in range(0, size, 2):
        row = ""
        for x in range(size):
            top, bottom = blend(y * size + x), blend((y + 1) * size + x)
            row += f"\x1b[38;2;{top[0]};{top[1]};{top[2]}m\x1b[48;2;{bottom[0]};{bottom[1]};{bottom[2]}m\u2580"
        print("  " + row + "\x1b[0m")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("images", nargs="+", help="source GIF/PNG files, in display order")
    parser.add_argument("--out", required=True, help="output JSON path")
    parser.add_argument("--size", type=int, default=20, help="sprite size in pixels (default 20)")
    parser.add_argument("--max-frames", type=int, default=20, help="frame cap per sprite (default 20)")
    parser.add_argument("--preview", type=int, help="print an ANSI preview of this sprite index and exit")
    args = parser.parse_args()

    sprites = []
    for path in args.images:
        if not os.path.exists(path):
            raise SystemExit(f"{path}: not found")
        frames, durations = decode(path)
        kept = thin(encode(frames, durations, args.size), args.max_frames)
        sprites.append(
            {
                "name": os.path.splitext(os.path.basename(path))[0],
                "frames": [{"px": pixels, "ms": ms} for pixels, ms in kept],
            }
        )
        print(f"{path}: {len(frames)} decoded -> {len(kept)} frames kept")

    if args.preview is not None:
        preview(sprites[args.preview], args.size)
        return

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as handle:
        json.dump({"size": args.size, "sprites": sprites}, handle, separators=(",", ":"))
    print(f"\nwrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB, {len(sprites)} sprites)")


if __name__ == "__main__":
    main()
