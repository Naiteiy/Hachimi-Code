import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SLIDING_ICON_WIDTH, SlidingIconRenderable } from "../../src/component/sliding-icon"
import icon from "../../src/component/sliding-icon/icon.json"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
let field: SlidingIconRenderable | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
  field = undefined
})

const ICON_W = icon.sprites[0]!.w

async function mount() {
  setup = await testRender(
    () => <sliding_icon ref={(value: SlidingIconRenderable) => (field = value)} width={SLIDING_ICON_WIDTH} height={3} fixedStep={40} />,
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

  test("sweeps both ways inside its own width", async () => {
    const view = await mount()
    const offsets: number[] = []
    for (let index = 0; index < 80; index++) {
      offsets.push(field!.offset)
      await view.renderOnce()
    }
    const min = Math.min(...offsets)
    const max = Math.max(...offsets)
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(SLIDING_ICON_WIDTH - ICON_W)
    // It must actually travel, in both directions.
    expect(max - min).toBeGreaterThanOrEqual(3)
    const rising = offsets.some((value, index) => index > 0 && value > offsets[index - 1]!)
    const falling = offsets.some((value, index) => index > 0 && value < offsets[index - 1]!)
    expect(rising).toBe(true)
    expect(falling).toBe(true)
  })
})
