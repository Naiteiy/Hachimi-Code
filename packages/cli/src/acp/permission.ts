import type {
  PermissionOption,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
} from "@agentclientprotocol/sdk"
import type { EventSubscribeOutput, OpenCodeClient, PermissionReplyInput } from "@opencode/client/promise"
import { Patch } from "@opencode/util/patch"
import { Cause, Effect, Exit } from "effect"
import type { ACPConnection } from "./connection"
import { ACPPromise } from "./promise"
import { ACPTranslate } from "./translate"
import { absolutePath, filePath, patchHunks, pendingToolCall, stringValue, toLocations, type ToolInput } from "./tool"

type PermissionEvent = Extract<EventSubscribeOutput, { type: "permission.asked" }>
type Tool = { readonly id: string; readonly name: string; readonly input: ToolInput }

type Input = {
  readonly client: OpenCodeClient
  readonly connection: ACPConnection.Interface
  readonly event: PermissionEvent
  readonly sessionID: string
  readonly clientSessionID: string
  readonly cwd: string
  readonly tool?: Tool
  readonly child?: ACPTranslate.ChildSession
  /** The client never received the asking tool call, so the ask announces one under the permission's ID. */
  readonly announce: boolean
}

const options: PermissionOption[] = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]

/**
 * Asks the client, then replies to the server. Once `cancelled` completes, the client's request is cancelled or never
 * sent, and the server gets `reject`. The server reply is uninterruptible, so a server that is alive but stuck can
 * hold a cancel past `CancelDrainTimeout`; a dead server fails fast.
 */
export const reply = Effect.fn("cli.acp.permission.reply")(function* (input: Input, cancelled: Effect.Effect<void>) {
  yield* Effect.uninterruptibleMask((restore) =>
    // The race starts racers in order and stops once one is done, so an earlier cancel never starts the ask.
    restore(cancelled.pipe(Effect.as("reject" as const), Effect.raceFirst(ask(input)))).pipe(
      Effect.tapCauseIf(Cause.hasDies, (cause) => Effect.logWarning("ACP permission ask failed", cause)),
      Effect.catchCause(() => Effect.succeed("reject" as const)),
      Effect.flatMap((decision) => respond(input, decision)),
    ),
  )
})

const ask = Effect.fnUntraced(function* (input: Input) {
  const toolCall = yield* permissionToolCall(input)
  if (!input.announce) return yield* select(input, toolCall)
  const update = (next: SessionUpdate) =>
    input.connection.sessionUpdate({ sessionId: input.clientSessionID, update: next }).pipe(Effect.ignoreCause)
  // The ask's tool call exists only for the client, so once announced it settles with the decision.
  return yield* Effect.acquireUseRelease(
    update({ sessionUpdate: "tool_call", ...toolCall }),
    () => select(input, toolCall),
    (_, exit) =>
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: toolCall.toolCallId,
        status: Exit.isSuccess(exit) && exit.value !== "reject" ? "completed" : "failed",
        _meta: toolCall._meta,
      }),
  )
})

const select = Effect.fnUntraced(function* (input: Input, toolCall: ToolCall) {
  const result = yield* input.connection.requestPermission({ sessionId: input.clientSessionID, toolCall, options })
  const selected = result.outcome.outcome === "selected" ? result.outcome.optionId : undefined
  return selected === "once" || selected === "always" ? selected : "reject"
})

const permissionToolCall = Effect.fnUntraced(function* (input: Input) {
  const toolName = input.tool?.name ?? input.event.data.action
  const toolInput = input.tool?.input ?? input.event.data.metadata ?? {}
  const previews = yield* permissionPreviews(toolName, toolInput, input.cwd).pipe(
    Effect.orElseSucceed((): ToolCallContent[] => []),
  )
  const toolCallID = input.tool && !input.announce ? input.tool.id : input.event.data.id
  const toolCall = pendingToolCall({
    toolCallId: input.child ? `${input.child.id}:${toolCallID}` : toolCallID,
    toolName,
    state: {
      input: toolInput,
      title: prefixedTitle(input.child?.title, permissionTitle(toolName, toolInput, previews)),
    },
    cwd: input.cwd,
  })
  return {
    ...toolCall,
    rawInput: input.tool ? toolCall.rawInput : undefined,
    locations: permissionLocations(toolName, toolInput, input.event.data.action, input.event.data.resources, input.cwd),
    ...(previews.length > 0 ? { content: previews } : {}),
    ...(input.child ? { _meta: ACPTranslate.childSessionMeta(input.child) } : {}),
  }
})

function respond(input: Input, decision: PermissionReplyInput["decision"]) {
  return ACPPromise.promise(() =>
    input.client.permission.reply({ sessionID: input.sessionID, requestID: input.event.data.id, decision }),
  )
}

function prefixedTitle(prefix: string | undefined, title: string | undefined) {
  if (!prefix) return title
  if (!title) return prefix
  return `${prefix}: ${title}`
}

const permissionPreviews = Effect.fnUntraced(function* (toolName: string, input: ToolInput, cwd: string) {
  const tool = toolName.toLocaleLowerCase()
  if (tool === "patch" || tool === "apply_patch") return yield* patchPreviews(input, cwd)
  const file = filePath(input)
  if (!file) return []
  const path = absolutePath(file, cwd)
  if (tool === "write") {
    const content = stringValue(input.content)
    if (content === undefined) return []
    return [diff(path, yield* readText(path), content)]
  }
  if (tool !== "edit") return []
  const oldString = stringValue(input.oldString)
  const newString = stringValue(input.newString)
  if (oldString === undefined || newString === undefined) return []
  const oldText = yield* readText(path)
  if (oldText === null) return []
  const newText =
    input.replaceAll === true ? oldText.replaceAll(oldString, newString) : oldText.replace(oldString, newString)
  return [diff(path, oldText, newText)]
})

// Patch.derive throws when a hunk does not match the current file, and a changed file may be missing; the patch then
// gets no previews.
function patchPreviews(input: ToolInput, cwd: string) {
  return Effect.forEach(
    patchHunks(input),
    (hunk) =>
      Effect.gen(function* () {
        const path = absolutePath(hunk.path, cwd)
        if (hunk.type === "add") {
          const newText = hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`
          return diff(path, null, newText)
        }
        const oldText = yield* Effect.fromNullishOr(yield* readText(path))
        if (hunk.type === "delete") return diff(path, oldText, "")
        const derived = yield* Effect.try(() => Patch.derive(hunk.path, hunk.chunks, oldText))
        return diff(hunk.movePath ? absolutePath(hunk.movePath, cwd) : path, oldText, derived.content)
      }),
    { concurrency: "unbounded" },
  )
}

function diff(path: string, oldText: string | null, newText: string): ToolCallContent {
  return { type: "diff", path, oldText, newText }
}

function permissionTitle(toolName: string, input: ToolInput, previews: ReadonlyArray<ToolCallContent>) {
  if (previews.length > 1) return `${previews.length} files`
  switch (toolName.toLocaleLowerCase()) {
    case "external_directory":
      return stringValue(input.description) ?? stringValue(input.command) ?? stringValue(input.parentDir)
    case "webfetch":
      return stringValue(input.url)
    case "websearch":
      return stringValue(input.query)
    case "grep":
    case "glob":
      return stringValue(input.pattern)
    case "read":
    case "edit":
    case "write":
    case "patch":
    case "apply_patch":
      return filePath(input) ?? (previews[0]?.type === "diff" ? previews[0].path : undefined)
    default:
      return undefined
  }
}

// Only these actions ask with path resources; an external directory asks for `<dir>/*`, located at the directory.
// Core's wildcard matching treats only `*` and `?` as special.
function permissionLocations(
  toolName: string,
  input: ToolInput,
  action: string,
  resources: ReadonlyArray<string>,
  cwd: string,
): ToolCallLocation[] {
  const locations = toLocations(toolName, input, cwd)
  if (locations.length > 0 || !PathActions.has(action)) return locations
  const paths = resources.flatMap((resource) => {
    const path = resource.endsWith("/*") ? resource.slice(0, -2) : resource
    return path && !/[*?]/.test(path) ? [absolutePath(path, cwd)] : []
  })
  return Array.from(new Set(paths), (path) => ({ path }))
}

const PathActions = new Set(["read", "edit", "external_directory"])

// Only a missing file reads as new (`null`); any other read error fails, so the ask gets no preview for it.
function readText(path: string) {
  return Effect.tryPromise({ try: () => Bun.file(path).text(), catch: (error) => error }).pipe(
    Effect.catchIf(
      (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
      () => Effect.succeed(null),
    ),
  )
}

export * as ACPPermission from "./permission"
