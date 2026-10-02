import { run as runTui, type TuiInput } from "@hachimi-code/tui"
import { Global } from "@hachimi-code/core/global"
import { AppNodeBuilder } from "@hachimi-code/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
