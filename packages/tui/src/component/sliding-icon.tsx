import {
  FrameBufferRenderable,
  RGBA,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from "@opentui/core"
import { extend } from "@opentui/solid"
import icon from "./sliding-icon/icon.json" with { type: "json" }

/** How far the icon travels either side of its resting place, in cells. */
const TRAVEL = 2
/** Seconds for one full left-right-left sweep. */
const PERIOD = 2.4
const TARGET_FPS = 30
/** Cells whose two pixels are both fully transparent are left untouched. */
const ALPHA_FLOOR = 1
/** Fallback step when a renderer reports no delta, so animation never stalls. */
const MIN_STEP = 16
const TOP_HALF = 0x2580
const SPRITE = icon.sprites[0]!
const SPRITE_W = SPRITE.w
const SPRITE_H = SPRITE.h / 2

type Phase = { fg: (RGBA | undefined)[]; bg: (RGBA | undefined)[] }
type Painted = { phases: Phase[] }

type SlidingIconOptions = RenderableOptions<FrameBufferRenderable> & {
  /** Overrides the renderer-supplied delta so the sweep is reproducible in tests. */
  fixedStep?: number
}

/**
 * The loading accent: a small picture that sweeps left and right next to the
 * activity spinner. The picture is baked into terminal cells the same way the
 * home memes are, because opentui has no image renderable.
 */
export class SlidingIconRenderable extends FrameBufferRenderable {
  private painted: Painted | undefined
  private clock = 0
  private step: number | undefined

  constructor(ctx: RenderContext, options: SlidingIconOptions = {}) {
    const { fixedStep, ...rest } = options
    super(ctx, {
      ...rest,
      width: typeof rest.width === "number" ? rest.width : SPRITE_W + TRAVEL * 2,
      height: typeof rest.height === "number" ? rest.height : SPRITE_H,
      live: rest.live ?? true,
      // Cells this layer never paints must let the page underneath show through.
      respectAlpha: true,
    })

    if (rest.width !== undefined && typeof rest.width !== "number") this.width = rest.width
    if (rest.height !== undefined && typeof rest.height !== "number") this.height = rest.height
    this.step = fixedStep
  }

  set fixedStep(value: number | undefined) {
    if (value === this.step) return
    this.step = value
    this.requestRender()
  }

  /** Cell the icon currently starts at, so tests can assert the sweep. */
  get offset() {
    return Math.round(TRAVEL + TRAVEL * Math.sin((this.clock / PERIOD) * Math.PI * 2))
  }

  protected override renderSelf(buffer: OptimizedBuffer, deltaTime = 0): void {
    if (!this.visible || this.isDestroyed) return

    const step = this.step ?? (deltaTime > 0 ? deltaTime : MIN_STEP)
    this.clock += step / 1000

    const frameBuffer = this.frameBuffer
    const width = frameBuffer.width
    const height = frameBuffer.height
    // The icon is drawn exactly as baked: inked cells take the picture's own
    // colours and everything else stays untouched, so the panel behind it shows
    // through instead of a rectangle of blended background.
    this.painted ??= { phases: blend(SPRITE.frames[0]!.px, SPRITE.w, SPRITE.h) }

    // A sine sweep eases at both ends, so the icon reads as sliding rather than snapping.
    const progress = (this.clock / PERIOD) % 1
    const originX = Math.round(TRAVEL + TRAVEL * Math.sin(progress * Math.PI * 2))
    const painted = this.painted.phases[0]!

    frameBuffer.clear()
    for (let row = 0; row < SPRITE_H; row++) {
      const y = row
      if (y < 0 || y >= height) continue
      for (let column = 0; column < SPRITE_W; column++) {
        const x = originX + column
        if (x < 0 || x >= width) continue
        const cell = row * SPRITE_W + column
        const fg = painted.fg[cell]
        const bg = painted.bg[cell]
        if (!fg || !bg) continue
        frameBuffer.drawChar(TOP_HALF, x, y, fg, bg)
      }
    }

    super.renderSelf(buffer)
  }
}

/**
 * Split the icon into per-cell colours. A cell is one pixel wide and two pixels
 * tall, so it carries the colours of both pixels; transparent pixels collapse to
 * the theme background and invisible cells stay out of the arrays.
 */
function blend(encoded: string, width: number, height: number): Phase[] {
  const bytes = Buffer.from(encoded, "base64")
  const rows = height / 2
  return [0, 1].map((phase) => {
    const fg: (RGBA | undefined)[] = new Array(rows * width)
    const bg: (RGBA | undefined)[] = new Array(rows * width)
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < width; column++) {
        const top = pixel(bytes, width, height, row * 2 - phase, column)
        const bottom = pixel(bytes, width, height, row * 2 + 1 - phase, column)
        if (top.a < ALPHA_FLOOR && bottom.a < ALPHA_FLOOR) continue
        const cell = row * width + column
        fg[cell] = opaque(top)
        bg[cell] = opaque(bottom)
      }
    }
    return { fg, bg }
  })
}

function pixel(bytes: Buffer, width: number, height: number, row: number, column: number) {
  if (row < 0 || row >= height) return { r: 0, g: 0, b: 0, a: 0 }
  const offset = (row * width + column) * 4
  return { r: bytes[offset]!, g: bytes[offset + 1]!, b: bytes[offset + 2]!, a: bytes[offset + 3]! }
}

function opaque(value: { r: number; g: number; b: number; a: number }) {
  return RGBA.fromInts(value.r, value.g, value.b)
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    sliding_icon: typeof SlidingIconRenderable
  }
}

extend({ sliding_icon: SlidingIconRenderable })

export const SLIDING_ICON_WIDTH = SPRITE_W + TRAVEL * 2
export const SLIDING_ICON_HEIGHT = SPRITE_H

export function SlidingIcon() {
  return <sliding_icon width={SLIDING_ICON_WIDTH} height={SLIDING_ICON_HEIGHT} />
}
