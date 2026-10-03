import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { MEME_SPACING, MEME_SPRITES, MemeFieldRenderable } from "../../src/component/home-memes"
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
const SPACING = MEME_SPACING

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

async function mount(seed: number, width = 120, height = 30) {
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

  test("keeps every meme apart, on its own slanted column", async () => {
    const view = await mount(21, 200, 40)
    for (let index = 0; index < 120; index++) {
      await view.renderOnce()
      const boxes = field!.boxes
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          expect(overlaps(boxes[a]!, boxes[b]!)).toBe(false)
        }
      }
      // Within a column the memes sit on one 45 degree line: x + 2y is constant.
      for (let column = 0; column < field!.columnCount; column++) {
        const line = boxes.filter((box) => box.column === column).map((box) => box.x + 2 * box.y)
        expect(Math.max(...line) - Math.min(...line)).toBeLessThan(1)
      }
    }
  })

  test("runs neighbouring columns against each other at 45 degrees", async () => {
    await mount(4, 200, 40)
    const directions = new Map<number, number>()
    for (const box of field!.boxes) {
      directions.set(box.column, box.direction)
      // A row is two pixels tall, so two cells per row is a true 45 degrees.
      expect(Math.abs(box.vx)).toBeCloseTo(2 * Math.abs(box.vy), 5)
      expect(box.vy).not.toBe(0)
    }
    for (let column = 1; column < field!.columnCount; column++) {
      expect(directions.get(column)).toBe(-directions.get(column - 1)!)
    }
  })

  test("spaces memes evenly along a column", async () => {
    await mount(6, 200, 40)
    for (let column = 0; column < field!.columnCount; column++) {
      const ys = field!.boxes
        .filter((box) => box.column === column)
        .map((box) => box.y)
        .sort((a, b) => a - b)
      expect(ys.length).toBeGreaterThan(1)
      for (let index = 1; index < ys.length; index++) {
        // Evenly spaced, allowing the single gap where the column wraps.
        const gap = ys[index]! - ys[index - 1]!
        expect(gap === SPACING || gap > SPACING).toBe(true)
      }
    }
  })

  test("sizes the column count from the frame width", async () => {
    await mount(2, 120, 20)
    const narrow = field!.columnCount
    setup?.renderer.destroy()
    field = undefined
    await mount(2, 400, 20)
    expect(field!.columnCount).toBeGreaterThan(narrow)
  })
})

describe("meme field class contract", () => {
  test("exposes the renderable used by the JSX tag", () => {
    expect(typeof MemeFieldRenderable).toBe("function")
    expect(MEME_SPRITES).toBeGreaterThan(1)
  })
})
