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
/** Rows travelled per second along a lane. */
const SPEED = 9
/** Cells of drift per row. A row is twice as tall as a cell is wide, so 2 gives a
 *  true 45 degree slant; the sign is applied per lane to lean every streak left. */
const SLOPE = 2
/** Blank rows between two memes inside one lane. */
const V_GAP = 4
/** Blank columns between two lanes. */
const H_GAP = 2
/** Lanes to keep room for, so adjacent lanes can always run against each other. */
const MIN_LANES = 2
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
 * One meme travelling one lane. Position is derived from the shared clock rather
 * than accumulated, so a lane can never drift out of step with its neighbours.
 */
type Actor = {
  sprite: number
  lane: number
  /** +1 or -1; adjacent lanes get opposite signs and so scroll against each other. */
  direction: number
  startY: number
  startX: number
  frame: number
  elapsed: number
  painted?: Painted
}

/**
 * A lane is a slanted conveyor: `spanY` rows tall and `spanX` cells of drift, so
 * the ratio `spanX / spanY` matches the travel slope and a meme leaves the lane
 * exactly where the next one enters it.
 */
type Field = {
  lanes: number
  offsetX: number
  laneW: number
  spanX: number
  spanY: number
  spacing: number
  perLane: number
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

  /** Current footprints and headings, so tests can assert the lane discipline. */
  get boxes() {
    const field = this.field
    if (!field) return []
    return this.actors.map((actor) => {
      const spot = this.place(actor, field)
      const lean = field.spanY === 0 ? 0 : field.spanX / field.spanY
      return {
        lane: actor.lane,
        direction: actor.direction,
        x: spot.x,
        y: spot.y,
        width: SPRITE_W,
        height: SPRITE_H,
        vx: actor.direction * SPEED * lean,
        vy: actor.direction * SPEED,
      }
    })
  }

  get laneCount() {
    return this.field?.lanes ?? 0
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

  /** Lay the lanes out for the current frame and restart the shower. */
  private respawn() {
    if (this.cells.width <= 0 || this.cells.height <= 0) {
      this.field = undefined
      this.actors = []
      return
    }
    this.field = this.layout(this.cells.width, this.cells.height)
    this.actors = this.build(this.field)
    this.clock = 0
    this.requestRender()
  }

  /**
   * How many lanes fit, and how far each one slants. Everything scales from the
   * frame size in cells, so the shower adapts to any terminal on any platform.
   */
  private layout(width: number, height: number): Field {
    const spacing = SPRITE_H + V_GAP
    const perLane = Math.max(1, Math.ceil((height + SPRITE_H) / spacing))
    const spanY = perLane * spacing
    // The drift box is exactly as wide as the 45 degree run over one cycle, so a
    // meme leaves its lane precisely where the next one enters.
    const ideal = Math.round(SLOPE * spanY)
    // At 45 degrees a lane is as wide as twice the frame height, so a true 45
    // degree slant leaves room for only one lane. Keep enough lanes to have
    // neighbours run against each other and steepen the slant as far as they allow.
    const fit = Math.floor(width / MIN_LANES) - SPRITE_W - H_GAP
    const spanX = Math.max(0, Math.min(ideal, fit))
    const lanes = Math.max(1, Math.floor(width / (SPRITE_W + spanX + H_GAP)))
    const laneW = SPRITE_W + spanX + H_GAP
    return { lanes, offsetX: Math.max(0, Math.floor((width - lanes * laneW) / 2)), laneW, spanX, spanY, spacing, perLane }
  }

  private build(field: Field): Actor[] {
    const actors: Actor[] = []
    for (let lane = 0; lane < field.lanes; lane++) {
      // Every other lane runs the other way, so neighbours slide against each other.
      const direction = lane % 2 === 0 ? 1 : -1
      for (let slot = 0; slot < field.perLane; slot++) {
        const sprite = (lane * field.perLane + slot) % MEME_SPRITES
        actors.push({
          sprite,
          lane,
          direction,
          // One diagonal line per lane with even spacing, offset per lane so the
          // lanes do not line up into visible rows.
          startY: (slot * field.spacing + (lane * field.spacing) / 2) % field.spanY,
          startX: 0,
          frame: Math.floor(this.random() * memes.sprites[sprite]!.frames.length),
          elapsed: 0,
        })
      }
    }
    return actors
  }

  private place(actor: Actor, field: Field) {
    const travel = this.clock * actor.direction * SPEED
    // The slant comes from the lane's own proportions rather than the nominal
    // constant, so one drift period covers exactly one row period and memes wrap
    // onto the diagonal without ever jumping sideways.
    const lean = field.spanY === 0 ? 0 : field.spanX / field.spanY
    // Descending lanes lean left and ascending ones lean right, which is the same
    // diagonal traversed in opposite senses. A frame with no room to lean falls
    // back to straight vertical travel rather than dividing by an empty span.
    const drift = field.spanX === 0 ? 0 : mod(actor.startX - travel * lean, field.spanX)
    return {
      x: field.offsetX + actor.lane * field.laneW + drift,
      y: mod(actor.startY + travel, field.spanY) - SPRITE_H,
    }
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
