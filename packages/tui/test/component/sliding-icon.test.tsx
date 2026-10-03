import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { SlidingIconRenderable } from "../../src/component/sliding-icon"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
let icon: SlidingIconRenderable | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
  icon = undefined
})

const BASE = RGBA.fromInts(0x17, 0x0f, 0x07)

async function mount() {
  setup = await testRender(
    () => (
      <sliding_icon
        ref={(value: SlidingIconRenderable) => (icon = value)}
        width={23}
        height={4}
        baseColor={BASE}
        fixedStep={40}
      />
    ),
    { width: 60, height: 10 },
  )
  await setup.renderOnce()
  return setup
}

function painted(frame: string) {
  return frame.split("").filter((char) => char === "\u2580").length
}

describe("sliding loading icon", () => {
  // Touching the class at runtime keeps the import: a type-only reference is
  // elided, which would skip the extend() registration and the JSX would fail.
  test("registers the renderable", () => {
    expect(typeof SlidingIconRenderable).toBe("function")
  })

  test("paints the icon", async () => {
    const view = await mount()
    expect(painted(view.captureCharFrame())).toBeGreaterThan(5)
  })

  test("sweeps left and right and comes back", async () => {
    const view = await mount()
    const offsets: number[] = []
    for (let index = 0; index < 80; index++) {
      offsets.push(icon!.offset)
      await view.renderOnce()
    }
    const min = Math.min(...offsets)
    const max = Math.max(...offsets)
    // It must travel a real distance, and both directions must be visited.
    expect(max - min).toBeGreaterThanOrEqual(8)
    const rising = offsets.findIndex((value, index) => index > 0 && value > offsets[index - 1]!)
    const falling = offsets.findIndex((value, index) => index > 0 && value < offsets[index - 1]!)
    expect(rising).toBeGreaterThan(-1)
    expect(falling).toBeGreaterThan(-1)
  })

  test("stays inside its own width", async () => {
    const view = await mount()
    for (let index = 0; index < 80; index++) {
      await view.renderOnce()
      expect(icon!.offset).toBeGreaterThanOrEqual(0)
      expect(icon!.offset).toBeLessThanOrEqual(23 - 13)
    }
  })
})
