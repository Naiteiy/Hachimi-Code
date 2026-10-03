import { createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"

/**
 * The loading accent: one character that sweeps left and right beside the
 * activity spinner.
 *
 * It is deliberately a glyph rather than a baked picture. A cell grid can carry
 * at most two full colour pixels per cell (an upper and a lower half block), so a
 * small picture is stuck between being too big to sit in this line or too coarse
 * to read at all. A glyph is drawn by the terminal's font, so it stays sharp at
 * any size and needs no background of its own.
 */
const GLYPH = "🐱"
/** Cells the glyph occupies in a terminal. Emoji render two cells wide. */
const GLYPH_WIDTH = 2
/** How far it travels either side of its resting place. */
const TRAVEL = 2
/** Seconds for one full left-right-left sweep. */
const PERIOD = 2.4
const TICK = 40

export const SLIDING_ICON_WIDTH = GLYPH_WIDTH + TRAVEL * 2

/** Cell the glyph sits at, `TRAVEL` seconds into the sweep. Sine eases both ends. */
export function sweepOffset(seconds: number) {
  return Math.round(TRAVEL + TRAVEL * Math.sin(((seconds / PERIOD) % 1) * Math.PI * 2))
}

export function SlidingIcon() {
  const { theme } = useTheme()
  const [offset, setOffset] = createSignal(TRAVEL)

  onMount(() => {
    const started = Date.now()
    const timer = setInterval(() => {
      setOffset(sweepOffset((Date.now() - started) / 1000))
    }, TICK)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box width={SLIDING_ICON_WIDTH} height={1} flexShrink={0} paddingLeft={offset()}>
      <text fg={theme.accent}>{GLYPH}</text>
    </box>
  )
}
