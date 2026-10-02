import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { MEME_COUNT, MemeFieldRenderable } from "../../src/component/home-memes"
import memes from "../../src/component/home-memes/memes.json"

let setup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
  field = undefined
})

let field: MemeFieldRenderable | undefined

const BASE = RGBA.fromInts(0x17, 0x0f, 0x07)
// A fixed step keeps the drift and the animation frames reproducible in tests.
const STEP = 16
const ALPHA_FLOOR = 8

/**
 * Upper bound on painted cells: each actor can at most paint the busiest frame
 * of its sprite. Cells accumulate beyond this only if the layer forgets to
 * clear, which is exactly the trailing bug this guards against.
 */
const BUDGET = memes.sprites.slice(0, MEME_COUNT).reduce((total, sprite) => {
  const perFrame = sprite.frames.map((frame) => {
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
  })
  return total + Math.max(...perFrame)
}, 0)

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

describe("home meme field", () => {
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
    const field = await mount(5)
    const first = field.captureCharFrame()
    for (let index = 0; index < 80; index++) await field.renderOnce()
    expect(field.captureCharFrame()).not.toBe(first)
  })

  test("never paints more than the sprites can occupy", async () => {
    const view = await mount(9)
    for (let index = 0; index < 120; index++) {
      await view.renderOnce()
      expect(painted(view.captureCharFrame())).toBeLessThanOrEqual(BUDGET)
    }
  })

  test("stays within the terminal bounds", async () => {
    const view = await mount(3, 24, 12)
    for (let index = 0; index < 120; index++) await view.renderOnce()
    const lines = view.captureCharFrame().replace(/\n$/, "").split("\n")
    expect(lines).toHaveLength(12)
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(24)
  })

  test("keeps every meme apart and inside the frame", async () => {
    const view = await mount(21, 90, 26)
    for (let index = 0; index < 200; index++) {
      await view.renderOnce()
      const boxes = field!.boxes
      // A crowded frame places fewer memes, never overlapping ones.
      expect(boxes.length).toBeGreaterThan(0)
      expect(boxes.length).toBeLessThanOrEqual(MEME_COUNT)
      for (const box of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(90)
        expect(box.y + box.height).toBeLessThanOrEqual(26)
      }
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          expect(overlaps(boxes[a]!, boxes[b]!)).toBe(false)
        }
      }
    }
  })

  test("moves faster than a crawl", async () => {
    await mount(4, 90, 26)
    for (const box of field!.boxes) {
      expect(Math.hypot(box.vx, box.vy)).toBeGreaterThan(3)
    }
  })
})

describe("meme field class contract", () => {
  test("exposes the renderable used by the JSX tag", () => {
    expect(typeof MemeFieldRenderable).toBe("function")
  })
})
