import { describe, expect, test } from "bun:test"
import { SLIDING_ICON_WIDTH, sweepOffset } from "../../src/component/sliding-icon"

const TRAVEL = 2

describe("sliding loading icon", () => {
  test("rests in the middle and reaches both ends", () => {
    const samples = Array.from({ length: 120 }, (_, index) => sweepOffset(index * 0.02))
    expect(Math.min(...samples)).toBe(0)
    expect(Math.max(...samples)).toBe(TRAVEL * 2)
  })

  test("moves smoothly, a cell at a time", () => {
    const samples = Array.from({ length: 240 }, (_, index) => sweepOffset(index * 0.01))
    for (let index = 1; index < samples.length; index++) {
      expect(Math.abs(samples[index]! - samples[index - 1]!)).toBeLessThanOrEqual(1)
    }
  })

  test("stays inside its own width", () => {
    for (let index = 0; index < 400; index++) {
      const offset = sweepOffset(index * 0.01)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset + 2).toBeLessThanOrEqual(SLIDING_ICON_WIDTH)
    }
  })

  test("visits both directions", () => {
    const samples = Array.from({ length: 120 }, (_, index) => sweepOffset(index * 0.02))
    expect(samples.some((value, index) => index > 0 && value > samples[index - 1]!)).toBe(true)
    expect(samples.some((value, index) => index > 0 && value < samples[index - 1]!)).toBe(true)
  })
})
