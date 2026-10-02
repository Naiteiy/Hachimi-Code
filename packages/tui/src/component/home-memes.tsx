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
export const MEME_COUNT = 4
/** Global alpha of the layer, so the memes read as a watermark behind the prompt. */
const OPACITY = 0.35
/** Drift speed in terminal cells per second. */
const SPEED = 5
/** Separation rounds per frame, so a three-way pile-up still resolves. */
const COLLISION_PASSES = 4
const TARGET_FPS = 20
/** Cells whose two pixels are both below this alpha are left untouched. */
const ALPHA_FLOOR = 8
/** Fallback step when a renderer reports no delta, so animation never stalls. */
const MIN_STEP = 16
const TOP_HALF = 0x2580
const SPRITES = memes.sprites.length
// Average footprint, used to decide how many memes actually fit on screen.
const AREA = memes.sprites.reduce((total, sprite) => total + sprite.w * (sprite.h / 2), 0) / SPRITES

type Sprite = (typeof memes.sprites)[number]
type Painted = { frame: number; base: RGBA; fg: (RGBA | undefined)[]; bg: (RGBA | undefined)[] }

type Actor = {
  sprite: number
  x: number
  y: number
  vx: number
  vy: number
  /** Speed to restore after a collision, since an axis swap can cancel motion. */
  speed: number
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
      this.advance(actor, memes.sprites[actor.sprite]!, step, width, height)
    }
    this.separate(width, height)
    for (const actor of this.actors) {
      this.paint(actor, memes.sprites[actor.sprite]!, width, height)
    }

    super.renderSelf(buffer)
  }

  /** Current footprints, so tests can assert the sprites stay apart. */
  get boxes() {
    return this.actors.map((actor) => {
      const sprite = memes.sprites[actor.sprite]!
      return { x: actor.x, y: actor.y, width: sprite.w, height: sprite.h / 2, vx: actor.vx, vy: actor.vy }
    })
  }

  /**
   * Push overlapping memes apart along their shallowest overlap and swap the
   * velocity on that axis, so a meeting reads as a bounce rather than a pass
   * through. Runs a few rounds because one push can create the next overlap.
   */
  private separate(width: number, height: number) {
    for (let pass = 0; pass < COLLISION_PASSES; pass++) {
      let collided = false
      for (let left = 0; left < this.actors.length; left++) {
        for (let right = left + 1; right < this.actors.length; right++) {
          const a = this.actors[left]!
          const b = this.actors[right]!
          const aSize = this.footprint(a)
          const bSize = this.footprint(b)
          const overlapX = Math.min(a.x + aSize.width, b.x + bSize.width) - Math.max(a.x, b.x)
          const overlapY = Math.min(a.y + aSize.height, b.y + bSize.height) - Math.max(a.y, b.y)
          if (overlapX <= 0 || overlapY <= 0) continue
          collided = true

          // Separate along the shallower overlap, but only where both memes
          // actually have room: clamping at the frame edge would undo the push.
          const pushX = overlapX / 2 + 0.01
          const pushY = overlapY / 2 + 0.01
          const roomX = this.room(a, aSize, b, bSize, pushX, "x", width, height)
          const roomY = this.room(a, aSize, b, bSize, pushY, "y", width, height)
          if (roomX && (!roomY || overlapX <= overlapY)) {
            const direction = a.x <= b.x ? 1 : -1
            a.x -= pushX * direction
            b.x += pushX * direction
            const swap = a.vx
            a.vx = b.vx
            b.vx = swap
          } else if (roomY) {
            const direction = a.y <= b.y ? 1 : -1
            a.y -= pushY * direction
            b.y += pushY * direction
            const swap = a.vy
            a.vy = b.vy
            b.vy = swap
          }
        }
      }
      if (!collided) break
    }

    // Pushing apart can shove a meme past an edge, so put it back, and restore
    // pace because exchanging one axis can leave a meme nearly stopped.
    for (const actor of this.actors) {
      const size = this.footprint(actor)
      actor.x = Math.min(Math.max(0, actor.x), Math.max(0, width - size.width))
      actor.y = Math.min(Math.max(0, actor.y), Math.max(0, height - size.height))

      const current = Math.hypot(actor.vx, actor.vy)
      if (current < actor.speed * 0.5) {
        const angle = this.random() * Math.PI * 2
        actor.vx = Math.cos(angle) * actor.speed
        actor.vy = Math.sin(angle) * actor.speed * 0.6
        continue
      }
      const scale = actor.speed / current
      actor.vx *= scale
      actor.vy *= scale
    }
  }

  /** Would pushing these two apart along `axis` keep both inside the frame? */
  private room(
    a: Actor,
    aSize: { width: number; height: number },
    b: Actor,
    bSize: { width: number; height: number },
    push: number,
    axis: "x" | "y",
    width: number,
    height: number,
  ) {
    const limitA = axis === "x" ? width - aSize.width : height - aSize.height
    const limitB = axis === "x" ? width - bSize.width : height - bSize.height
    const posA = axis === "x" ? a.x : a.y
    const posB = axis === "x" ? b.x : b.y
    const direction = posA <= posB ? 1 : -1
    const nextA = posA - push * direction
    const nextB = posB + push * direction
    return nextA >= 0 && nextA <= limitA && nextB >= 0 && nextB <= limitB
  }

  private footprint(actor: Actor) {
    const sprite = memes.sprites[actor.sprite]!
    return { width: sprite.w, height: sprite.h / 2 }
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
    this.actors = []
    // Overlap is geometrically impossible to avoid when the frame is crowded,
    // so place only as many memes as the area comfortably holds.
    const budget = Math.floor((this.cells.width * this.cells.height) / (AREA * 2.5))
    const slots = Math.max(1, Math.min(MEME_COUNT, SPRITES, budget))
    for (let slot = 0; slot < slots; slot++) {
      // Round-robin so every supplied meme gets on screen, then randomise.
      const sprite = slot % SPRITES
      const size = { width: memes.sprites[sprite]!.w, height: memes.sprites[sprite]!.h / 2 }
      const maxX = Math.max(0, this.cells.width - size.width)
      const maxY = Math.max(0, this.cells.height - size.height)
      const angle = this.random() * Math.PI * 2
      const speed = SPEED * (0.6 + this.random() * 0.6)

      // Try not to start on top of a meme that is already placed; the drift
      // separate() pass would sort it out, but a clean start looks deliberate.
      let x = 0
      let y = 0
      for (let attempt = 0; attempt < 50; attempt++) {
        x = this.random() * maxX
        y = this.random() * maxY
        if (this.actors.every((other) => !this.overlaps(other, x, y, size))) break
      }

      this.actors.push({
        sprite,
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.6,
        speed,
        frame: Math.floor(this.random() * memes.sprites[sprite]!.frames.length),
        elapsed: 0,
      })
    }
  }

  private overlaps(other: Actor, x: number, y: number, size: { width: number; height: number }) {
    const otherSize = this.footprint(other)
    return (
      x < other.x + otherSize.width && other.x < x + size.width && y < other.y + otherSize.height && other.y < y + size.height
    )
  }

  private advance(actor: Actor, sprite: Sprite, step: number, width: number, height: number) {
    const maxX = Math.max(0, width - sprite.w)
    const maxY = Math.max(0, height - sprite.h / 2)

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

  private paint(actor: Actor, sprite: Sprite, width: number, height: number) {
    const frame = sprite.frames[actor.frame]!
    if (actor.painted?.frame !== actor.frame || !sameColor(actor.painted.base, this.base)) {
      actor.painted = { frame: actor.frame, base: this.base, ...blend(frame.px, sprite.w, sprite.h, this.base) }
    }

    const target = this.frameBuffer
    const rows = sprite.h / 2
    const originX = Math.round(actor.x)
    const originY = Math.round(actor.y)
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
