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

export const MEME_SPRITES = memes.sprites.length

/** Global alpha of the layer, so the shower reads as a watermark behind the prompt. */
const OPACITY = 0.35
/** Rows travelled per second along a column. */
const SPEED = 9
/** Cells travelled sideways per row. A row is two pixels tall and a cell is one
 *  pixel wide, so 2 is a true 45 degree column. */
const LEAN = 2
/** Blank rows between two memes inside one column. */
const V_GAP = 4
/** Smallest horizontal gap between two columns. */
const H_GAP = 3
/**
 * Columns are parallel 45 degree lines. Two of them keep their memes at least
 * half the period apart on the x axis at every point of the cycle, so a period of
 * twice a sprite's width is the smallest that cannot overlap.
 */
const PERIOD = 2 * (memes.sprites[0]!.w + H_GAP)
const TARGET_FPS = 20
/** Cells whose two pixels are both below this alpha are left untouched. */
const ALPHA_FLOOR = 8
/** Fallback step when a renderer reports no delta, so animation never stalls. */
const MIN_STEP = 16
const TOP_HALF = 0x2580
// Every sprite is baked to one canvas, so the layout can treat them as equal.
const SPRITE_W = memes.sprites[0]!.w
const SPRITE_H = memes.sprites[0]!.h / 2

type Sprite = (typeof memes.sprites)[number]
type Painted = { frame: number; base: RGBA; fg: (RGBA | undefined)[]; bg: (RGBA | undefined)[] }

/**
 * One meme on one column. `slot` is its position along the column, measured in
 * rows: the meme sits at `slot` rows and `-LEAN * slot` cells, so the memes of a
 * column line up along the column's own 45 degree axis rather than a vertical one.
 */
type Actor = {
  sprite: number
  column: number
  /** +1 travels down-left, -1 travels up-right; adjacent columns differ. */
  direction: number
  slot: number
  frame: number
  elapsed: number
  painted?: Painted
}

type Field = {
  columns: number
  /** Rows in one full pass, always a whole number of slots so the stream is even. */
  cycle: number
  spacing: number
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
  private field: Field | undefined
  private clock = 0
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
    if (seed !== undefined) {
      this.seedValue = seed
      this.random = mulberry32(seed)
    }
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

  /** Current footprints and headings, so tests can assert the column geometry. */
  get boxes() {
    const field = this.field
    if (!field) return []
    return this.actors.map((actor) => {
      const spot = this.place(actor, field)
      return {
        column: actor.column,
        direction: actor.direction,
        x: spot.x,
        y: spot.y,
        width: SPRITE_W,
        height: SPRITE_H,
        vx: -actor.direction * LEAN * SPEED,
        vy: actor.direction * SPEED,
      }
    })
  }

  get columnCount() {
    const field = this.field
    if (!field) return 0
    return field.columns
  }

  protected override renderSelf(buffer: OptimizedBuffer, deltaTime = 0): void {
    if (!this.visible || this.isDestroyed) return

    const frameBuffer = this.frameBuffer
    const width = frameBuffer.width
    const height = frameBuffer.height
    const step = this.step ?? (deltaTime > 0 ? deltaTime : MIN_STEP)

    if (this.cells.width !== width || this.cells.height !== height) {
      this.cells = { width, height }
      this.respawn()
    }

    this.clock += step / 1000
    if (!this.field) return

    // Memes move, so the previous frame has to be wiped or they leave trails.
    frameBuffer.clear()
    for (const actor of this.actors) {
      this.advance(actor, memes.sprites[actor.sprite]!, step)
      this.paint(actor, this.field, width, height)
    }

    super.renderSelf(buffer)
  }

  /** Rebuild every cached frame because the colour they blend against changed. */
  private repaint(value: RGBA) {
    this.base = value
    for (const actor of this.actors) actor.painted = undefined
    this.requestRender()
  }

  /** Lay the columns out for the current frame and restart the shower. */
  private respawn() {
    if (this.cells.width <= 0 || this.cells.height <= 0) {
      this.field = undefined
      this.actors = []
      return
    }
    this.field = this.layout(this.cells.height)
    this.actors = this.build(this.field, this.cells.width)
    this.clock = 0
    this.requestRender()
  }

  /** How many slanted columns the frame holds, and how long one pass is. */
  private layout(height: number): Field {
    const spacing = SPRITE_H + V_GAP
    // A whole number of slots per pass keeps the spacing identical across the wrap.
    const perColumn = Math.max(1, Math.ceil((height + SPRITE_H) / spacing))
    return { columns: 0, cycle: perColumn * spacing, spacing }
  }

  private build(field: Field, width: number): Actor[] {
    // One column per period, plus two so memes starting off the right edge drift in.
    const columns = Math.max(1, Math.floor(width / PERIOD) + 2)
    field.columns = columns

    const actors: Actor[] = []
    const perColumn = field.cycle / field.spacing
    for (let column = 0; column < columns; column++) {
      // Neighbouring columns run against each other along their own axis.
      const direction = column % 2 === 0 ? 1 : -1
      for (let slot = 0; slot < perColumn; slot++) {
        const sprite = (column * perColumn + slot) % MEME_SPRITES
        actors.push({
          sprite,
          column,
          direction,
          // Even spacing along the column, offset per column so the columns do not
          // line up into visible rows.
          slot: (slot * field.spacing + (column * field.spacing) / 2) % field.cycle,
          frame: Math.floor(this.random() * memes.sprites[sprite]!.frames.length),
          elapsed: 0,
        })
      }
    }
    return actors
  }

  private place(actor: Actor, field: Field) {
    // Both senses share one line: x + LEAN * y is constant per column, so a single
    // offset along it drives the position and only the clock's sign differs.
    const travel = mod(actor.slot + actor.direction * this.clock * SPEED, field.cycle)
    return { x: columnOrigin(actor.column) - LEAN * travel, y: travel - SPRITE_H }
  }

  private advance(actor: Actor, sprite: Sprite, step: number) {
    const frames = sprite.frames
    actor.elapsed += step
    for (let guard = 0; guard < frames.length; guard++) {
      const current = frames[actor.frame]!
      if (actor.elapsed < current.ms) break
      actor.elapsed -= current.ms
      actor.frame = (actor.frame + 1) % frames.length
      actor.painted = undefined
    }
  }

  private paint(actor: Actor, field: Field, width: number, height: number) {
    const sprite = memes.sprites[actor.sprite]!
    const frame = sprite.frames[actor.frame]!
    if (actor.painted?.frame !== actor.frame || !sameColor(actor.painted.base, this.base)) {
      actor.painted = { frame: actor.frame, base: this.base, ...blend(frame.px, sprite.w, sprite.h, this.base) }
    }

    const spot = this.place(actor, field)
    const originX = Math.round(spot.x)
    const originY = Math.round(spot.y)
    const rows = sprite.h / 2
    const target = this.frameBuffer
    for (let row = 0; row < rows; row++) {
      const y = originY + row
      if (y < 0 || y >= height) continue
      for (let column = 0; column < sprite.w; column++) {
        const x = originX + column
        if (x < 0 || x >= width) continue
        const cell = row * sprite.w + column
        const fg = actor.painted.fg[cell]
        const bg = actor.painted.bg[cell]
        if (!fg || !bg) continue
        target.drawChar(TOP_HALF, x, y, fg, bg)
      }
    }
  }
}

/** Where a column crosses row zero. */
function columnOrigin(column: number) {
  return column * PERIOD
}

function mod(value: number, span: number) {
  return ((value % span) + span) % span
}

/**
 * Split one sprite frame into per-cell foreground/background colours.
 *
 * A cell is one pixel wide and two pixels tall, so it needs the colours of both
 * pixels. Transparent pixels collapse to the theme background, and cells where
 * nothing is visible stay undefined so `paint` skips them and the page
 * underneath is left alone.
 */
function blend(encoded: string, width: number, height: number, base: RGBA) {
  const bytes = Buffer.from(encoded, "base64")
  const rows = height / 2
  const fg: (RGBA | undefined)[] = new Array(rows * width)
  const bg: (RGBA | undefined)[] = new Array(rows * width)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < width; column++) {
      const top = pixel(bytes, (row * 2 * width + column) * 4)
      const bottom = pixel(bytes, ((row * 2 + 1) * width + column) * 4)
      if (top.a < ALPHA_FLOOR && bottom.a < ALPHA_FLOOR) continue
      const cell = row * width + column
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
