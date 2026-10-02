import { registerCustomTheme } from "@pierre/diffs"
import { HachimiCodeTheme } from "./marked-theme"

let registered = false

export function registerHachimiCodeTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("HACHIMI CODE", () => Promise.resolve(HachimiCodeTheme))
}
