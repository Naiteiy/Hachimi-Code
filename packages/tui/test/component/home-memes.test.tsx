import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { MEME_SPRITES, MemeFieldRenderable } from "../../src/component/home-memes"
import memes from "../../src/component/home-memes/memes.json"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
let field: MemeFieldRenderable | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
  field = undefined
})

const BASE = RGBA.fromInts(0x17, 0x0f, 0x07)
// A fixed step keeps the shower and the animation frames reproducible in tests.
const STEP = 16
const ALPHA_FLOOR = 8
const SPRITE_W = memes.sprites[0]!.w
const SPRITE_H = memes.sprites[0]!.h / 2

/** Busiest frame of any sprite, the most cells one meme can ever paint. */
const MAX_CELLS = Math.max(
  ...memes.sprites.flatMap((sprite) =>
    sprite.frames.map((frame) => {
      const bytes = Buffer.from(frame.px, "base64")
      let cells = 0
      for (let row = 0; row < sprite.h / 2; row++) {
        for (let column = 0; column < sprite.w; column++) {
          const top = bytes[(row * 2 * sprite.w + column) * 4 + 3]!
          const bottom = bytes[((row * 2 + 1) * sprite.w + column) * 4 + 3]!
          if (top >= ALPHA_FLOOR || bottom >= ALPHA_FLOOR) cells++
        }
      }
      return cells
    }),
  ),
)

async function mount(seed: number, width = 100, height = 30) {
  setup = await testRender(
    () => (
      <meme_field
        ref={(value: MemeFieldRenderable) => (field = value)}
        width={width}
        height={height}
        baseColor={BASE}
        seed={seed}
        fixedStep={STEP}
      />
    ),
    { width, height },
  )
  await setup.renderOnce()
  return setup
}

function painted(frame: string) {
  return frame.split("").filter((char) => char === "\u2580").length
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  // Half a cell of slack so float rounding does not read as a collision.
  const slack = 0.5
  return (
    a.x + slack < b.x + b.width && b.x + slack < a.x + a.width && a.y + slack < b.y + b.height && b.y + slack < a.y + a.height
  )
}

describe("home meme shower", () => {
  test("paints half-block pixels onto the home layer", async () => {
    const frame = (await mount(7)).captureCharFrame()
    expect(frame).toContain("\u2580")
    expect(painted(frame)).toBeGreaterThan(50)
  })

  test("is reproducible for a given seed", async () => {
    const first = (await mount(11)).captureCharFrame()
    setup?.renderer.destroy()
    const second = (await mount(11)).captureCharFrame()
    expect(second).toBe(first)
  })

  test("differs between seeds", async () => {
    const first = (await mount(1)).captureCharFrame()
    setup?.renderer.destroy()
    const second = (await mount(2)).captureCharFrame()
    expect(second).not.toBe(first)
  })

  test("drifts over time", async () => {
    const view = await mount(5)
    const first = view.captureCharFrame()
    for (let index = 0; index < 80; index++) await view.renderOnce()
    expect(view.captureCharFrame()).not.toBe(first)
  })

  test("never paints more than its memes can occupy", async () => {
    const view = await mount(9)
    for (let index = 0; index < 120; index++) {
      await view.renderOnce()
      expect(painted(view.captureCharFrame())).toBeLessThanOrEqual(MAX_CELLS * field!.boxes.length)
    }
  })

  test("fills the frame with memes that stay inside it", async () => {
    const view = await mount(3, 24, 12)
    for (let index = 0; index < 60; index++) await view.renderOnce()
    const boxes = field!.boxes
    expect(boxes.length).toBeGreaterThan(0)
    for (const box of boxes) {
      // A 45 degree streak may overhang a narrow frame; it must still be visible.
      expect(box.x + SPRITE_W).toBeGreaterThan(0)
      expect(box.x).toBeLessThan(24)
    }
    const lines = view.captureCharFrame().replace(/\n$/, "").split("\n")
    expect(lines).toHaveLength(12)
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(24)
  })

  test("keeps memes apart and alternates lane direction", async () => {
    const view = await mount(21, 90, 26)
    const baseline = field!.boxes
    const directions = new Map<number, number>()
    for (const box of baseline) {
      const known = directions.get(box.lane)
      if (known !== undefined) expect(box.direction).toBe(known)
      directions.set(box.lane, box.direction)
    }
    // Neighbouring lanes must run against each other.
    for (let lane = 1; lane < field!.laneCount; lane++) {
      if (!directions.has(lane) || !directions.has(lane - 1)) continue
      expect(directions.get(lane)).toBe(-directions.get(lane - 1)!)
    }

    for (let index = 0; index < 150; index++) {
      await view.renderOnce()
      const boxes = field!.boxes
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          if (boxes[a]!.lane === boxes[b]!.lane) continue
          // Lanes are disjoint horizontally, so only same-lane pairs can collide.
          expect(overlaps(boxes[a]!, boxes[b]!)).toBe(false)
        }
      }
      for (let lane = 0; lane < field!.laneCount; lane++) {
        const inLane = boxes.filter((box) => box.lane === lane)
        for (let a = 0; a < inLane.length; a++) {
          for (let b = a + 1; b < inLane.length; b++) {
            expect(overlaps(inLane[a]!, inLane[b]!)).toBe(false)
          }
        }
      }
    }
  })

  test("moves diagonally and faster than a crawl", async () => {
    await mount(4, 90, 26)
    for (const box of field!.boxes) {
      expect(Math.hypot(box.vx, box.vy)).toBeGreaterThan(3)
      expect(box.vx).not.toBe(0)
      expect(box.vy).not.toBe(0)
    }
  })

  test("sizes the lanes from the frame width", async () => {
    await mount(2, 120, 20)
    const narrow = field!.laneCount
    setup?.renderer.destroy()
    field = undefined
    await mount(2, 400, 20)
    expect(field!.laneCount).toBeGreaterThan(narrow)
  })
})

describe("meme field class contract", () => {
  test("exposes the renderable used by the JSX tag", () => {
    expect(typeof MemeFieldRenderable).toBe("function")
    expect(MEME_SPRITES).toBeGreaterThan(1)
  })
})
