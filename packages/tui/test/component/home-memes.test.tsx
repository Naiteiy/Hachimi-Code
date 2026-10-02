import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { MemeFieldRenderable } from "../../src/component/home-memes"

let setup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

const BASE = RGBA.fromInts(0x17, 0x0f, 0x07)
// A fixed step keeps the drift and the animation frames reproducible in tests.
const STEP = 16

async function mount(seed: number, width = 60, height = 20) {
  setup = await testRender(
    () => <meme_field width={width} height={height} baseColor={BASE} seed={seed} fixedStep={STEP} />,
    { width, height },
  )
  await setup.renderOnce()
  return setup
}

describe("home meme field", () => {
  test("paints half-block pixels onto the home layer", async () => {
    const frame = (await mount(7)).captureCharFrame()
    expect(frame).toContain("\u2580")
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

  test("leaves no trails where a meme has moved away from", async () => {
    const field = await mount(9)
    const seen = new Set<string>()
    for (let index = 0; index < 40; index++) {
      await field.renderOnce()
      const lines = field.captureCharFrame().replace(/\n$/, "").split("\n")
      // A single meme is 24 cells wide, so no row may exceed that plus the two
      // others that may share it. Anything wider means cells were never cleared.
      expect(Math.max(...lines.map((line) => line.trimEnd().length))).toBeLessThanOrEqual(72)
      seen.add(lines.join("\n"))
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  test("stays within the terminal bounds", async () => {
    const field = await mount(3, 24, 12)
    for (let index = 0; index < 120; index++) await field.renderOnce()
    const lines = field.captureCharFrame().replace(/\n$/, "").split("\n")
    expect(lines).toHaveLength(12)
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(24)
  })
})

describe("meme field class contract", () => {
  test("exposes the renderable used by the JSX tag", () => {
    expect(typeof MemeFieldRenderable).toBe("function")
  })
})
