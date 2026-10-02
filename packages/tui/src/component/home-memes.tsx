import {
  FrameBufferRenderable,
  RGBA,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from "@opentui/core"
import { extend, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { tint, useTheme } from "../context/theme"
import memes from "./home-memes/memes.json" with { type: "json" }

/** How many memes drift across the home screen at once. */
const COUNT = 4
/** Global alpha of the layer, so the memes read as a watermark behind the prompt. */
const OPACITY = 0.35
/** Drift speed in terminal cells per second. */
const SPEED = 2.2
const TARGET_FPS = 20
/** Cells whose two pixels are both below this alpha are left untouched. */
const ALPHA_FLOOR = 8
/** Fallback step when a renderer reports no delta, so animation never stalls. */
const MIN_STEP = 16
const TOP_HALF = 0x2580
const SIZE = memes.size
const ROWS = SIZE / 2
const SPRITES = memes.sprites.length

type Painted = { frame: number; base: RGBA; fg: (RGBA | undefined)[]; bg: (RGBA | undefined)[] }

type Actor = {
  sprite: number
  x: number
  y: number
  vx: number
  vy: number
  frame: number
  elapsed: number
  painted?: Painted
}

type MemeFieldOptions = RenderableOptions<FrameBufferRenderable> & {
  baseColor?: RGBA
  seed?: number
  /** Overrides the renderer-supplied delta so animation can be driven deterministically. */
  fixedStep?: number
}

export class MemeFieldRenderable extends FrameBufferRenderable {
  private actors: Actor[] = []
  private base = RGBA.fromInts(0, 0, 0)
  private cells = { width: 0, height: 0 }
  private random = Math.random
  private step: number | undefined
  private seedValue: number | undefined

  constructor(ctx: RenderContext, options: MemeFieldOptions = {}) {
    const { baseColor, seed, fixedStep, ...rest } = options
    super(ctx, {
      ...rest,
      width: typeof rest.width === "number" ? rest.width : 1,
      height: typeof rest.height === "number" ? rest.height : 1,
      live: rest.live ?? true,
      // Cells this layer never paints must let the page underneath show through.
      respectAlpha: true,
    })

    // Percentage sizes are resolved by the layout pass, after mount.
    if (rest.width !== undefined && typeof rest.width !== "number") this.width = rest.width
    if (rest.height !== undefined && typeof rest.height !== "number") this.height = rest.height
    if (baseColor) this.base = baseColor
    if (seed !== undefined) this.seedValue = seed
    if (seed !== undefined) this.random = mulberry32(seed)
    this.step = fixedStep
  }

  set baseColor(value: RGBA | undefined) {
    if (!value || sameColor(this.base, value)) return
    this.repaint(value)
  }

  /** Props reach a renderable through setters, so the seed has to be one too. */
  set seed(value: number | undefined) {
    if (value === undefined || value === this.seedValue) return
    this.seedValue = value
    this.random = mulberry32(value)
    this.respawn()
  }

  set fixedStep(value: number | undefined) {
    if (value === this.step) return
    this.step = value
    this.requestRender()
  }

  protected override renderSelf(buffer: OptimizedBuffer, deltaTime = 0): void {
    if (!this.visible || this.isDestroyed) return

    const frameBuffer = this.frameBuffer
    const width = frameBuffer.width
    const height = frameBuffer.height
    const step = this.step ?? (deltaTime > 0 ? deltaTime : MIN_STEP)

    if (this.cells.width !== width || this.cells.height !== height) {
      this.cells = { width, height }
      this.spawn()
    }

    // Memes move, so the previous frame has to be wiped or they leave trails.
    frameBuffer.clear()
    for (const actor of this.actors) {
      this.advance(actor, step, width, height)
      this.paint(actor, width, height)
    }

    super.renderSelf(buffer)
  }

  /** Rebuild every cached frame because the colour they blend against changed. */
  private repaint(value: RGBA) {
    this.base = value
    for (const actor of this.actors) actor.painted = undefined
    this.requestRender()
  }

  /** Discard every actor so the next render lays the field out again from scratch. */
  private respawn() {
    this.actors = []
    this.cells = { width: 0, height: 0 }
    this.requestRender()
  }

  private spawn() {
    const maxX = Math.max(0, this.cells.width - SIZE)
    const maxY = Math.max(0, this.cells.height - ROWS)
    this.actors = Array.from({ length: Math.min(COUNT, SPRITES) }, (_, index) => {
      const angle = this.random() * Math.PI * 2
      const speed = SPEED * (0.6 + this.random() * 0.6)
      return {
        // Round-robin so every supplied meme gets on screen, then randomise.
        sprite: index % SPRITES,
        x: this.random() * maxX,
        y: this.random() * maxY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.6,
        frame: Math.floor(this.random() * memes.sprites[index % SPRITES]!.frames.length),
        elapsed: 0,
      }
    })
  }

  private advance(actor: Actor, step: number, width: number, height: number) {
    const maxX = Math.max(0, width - SIZE)
    const maxY = Math.max(0, height - ROWS)

    actor.x += (actor.vx * step) / 1000
    actor.y += (actor.vy * step) / 1000

    if (actor.x < 0) {
      actor.x = 0
      actor.vx = Math.abs(actor.vx)
    } else if (actor.x > maxX) {
      actor.x = maxX
      actor.vx = -Math.abs(actor.vx)
    }
    if (actor.y < 0) {
      actor.y = 0
      actor.vy = Math.abs(actor.vy)
    } else if (actor.y > maxY) {
      actor.y = maxY
      actor.vy = -Math.abs(actor.vy)
    }

    const frames = memes.sprites[actor.sprite]!.frames
    actor.elapsed += step
    for (let guard = 0; guard < frames.length; guard++) {
      const current = frames[actor.frame]!
      if (actor.elapsed < current.ms) break
      actor.elapsed -= current.ms
      actor.frame = (actor.frame + 1) % frames.length
      actor.painted = undefined
    }
  }

  private paint(actor: Actor, width: number, height: number) {
    const sprite = memes.sprites[actor.sprite]!
    const frame = sprite.frames[actor.frame]!
    if (actor.painted?.frame !== actor.frame || !sameColor(actor.painted.base, this.base)) {
      actor.painted = { frame: actor.frame, base: this.base, ...blend(frame.px, this.base) }
    }

    const target = this.frameBuffer
    const originX = Math.round(actor.x)
    const originY = Math.round(actor.y)
    for (let row = 0; row < ROWS; row++) {
      const y = originY + row
      if (y < 0 || y >= height) continue
      for (let column = 0; column < SIZE; column++) {
        const x = originX + column
        if (x < 0 || x >= width) continue
        const cell = row * SIZE + column
        const fg = actor.painted.fg[cell]
        const bg = actor.painted.bg[cell]
        if (!fg || !bg) continue
        target.drawChar(TOP_HALF, x, y, fg, bg)
      }
    }
  }
}

/**
 * Split one sprite frame into per-cell foreground/background colours.
 *
 * A cell is one pixel wide and two pixels tall, so it needs the colours of both
 * pixels. Transparent pixels collapse to the theme background, and cells where
 * nothing is visible stay out of the arrays so `paint` skips them and the page
 * underneath is left alone.
 */
function blend(encoded: string, base: RGBA): { fg: (RGBA | undefined)[]; bg: (RGBA | undefined)[] } {
  const bytes = Buffer.from(encoded, "base64")
  const fg: (RGBA | undefined)[] = new Array(ROWS * SIZE)
  const bg: (RGBA | undefined)[] = new Array(ROWS * SIZE)
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < SIZE; column++) {
      const top = pixel(bytes, (row * 2 * SIZE + column) * 4)
      const bottom = pixel(bytes, ((row * 2 + 1) * SIZE + column) * 4)
      if (top.a < ALPHA_FLOOR && bottom.a < ALPHA_FLOOR) continue
      const cell = row * SIZE + column
      fg[cell] = mix(base, top)
      bg[cell] = mix(base, bottom)
    }
  }
  return { fg, bg }
}

function pixel(bytes: Buffer, offset: number) {
  return { r: bytes[offset]!, g: bytes[offset + 1]!, b: bytes[offset + 2]!, a: bytes[offset + 3]! }
}

function mix(base: RGBA, value: { r: number; g: number; b: number; a: number }) {
  return tint(base, RGBA.fromInts(value.r, value.g, value.b), (value.a / 255) * OPACITY)
}

function sameColor(a: RGBA, b: RGBA) {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a
}

/** Small deterministic PRNG so a seeded field is reproducible in tests. */
function mulberry32(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    meme_field: typeof MemeFieldRenderable
  }
}

extend({ meme_field: MemeFieldRenderable })

export function HomeMemes() {
  const { theme } = useTheme()
  const renderer = useRenderer()
  let targetFps = renderer.targetFps
  let maxFps = renderer.maxFps

  onMount(() => {
    targetFps = renderer.targetFps
    maxFps = renderer.maxFps
    renderer.targetFps = TARGET_FPS
    renderer.maxFps = TARGET_FPS
  })

  onCleanup(() => {
    renderer.targetFps = targetFps
    renderer.maxFps = maxFps
  })

  return <meme_field width="100%" height="100%" baseColor={theme.background} />
}
