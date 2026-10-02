import { Effect, Schema } from "effect"
import { Route } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Framing } from "../route/framing.js"
import { Protocol } from "../route/protocol.js"
import { LLMEvent, Usage, type FinishReasonDetails, type LLMRequest } from "../schema/index.js"
import { ProviderShared } from "./shared.js"
import { Lifecycle } from "./utils/lifecycle.js"
import { ToolStream } from "./utils/tool-stream.js"

const ADAPTER = "cohere-chat"
export const DEFAULT_BASE_URL = "https://api.cohere.com/v2"

const Options = Schema.Struct({
  thinking: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.Literals(["enabled", "disabled"])),
      tokenBudget: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
  ),
})
export type ProviderOptionsInput = Schema.Schema.Type<typeof Options>

const Content = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image_url"), image_url: Schema.Struct({ url: Schema.String }) }),
])
const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
})
const Message = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant", "tool"]),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Content)])),
  tool_calls: Schema.optional(Schema.Array(ToolCall)),
  tool_call_id: Schema.optional(Schema.String),
  tool_plan: Schema.optional(Schema.String),
})
const Body = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Message),
  stream: Schema.Literal(true),
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal("function"),
        function: Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          parameters: Schema.Unknown,
        }),
      }),
    ),
  ),
  tool_choice: Schema.optional(Schema.Literals(["NONE", "REQUIRED"])),
  thinking: Schema.optional(Schema.Struct({ type: Schema.String, token_budget: Schema.optional(Schema.Number) })),
  max_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  p: Schema.optional(Schema.Number),
  k: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number),
  stop_sequences: Schema.optional(Schema.Array(Schema.String)),
  frequency_penalty: Schema.optional(Schema.Number),
  presence_penalty: Schema.optional(Schema.Number),
})
const TokenCounts = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  reasoning_tokens: Schema.optional(Schema.Number),
})
const NativeUsage = Schema.Struct({
  tokens: Schema.optional(TokenCounts),
  billed_units: Schema.optional(TokenCounts),
  cached_tokens: Schema.optional(Schema.Number),
})
const ContentDelta = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
})
const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message-start") }),
  Schema.Struct({
    type: Schema.Literals(["content-start", "content-delta"]),
    index: Schema.Number,
    delta: Schema.Struct({ message: Schema.Struct({ content: ContentDelta }) }),
  }),
  Schema.Struct({ type: Schema.Literal("content-end"), index: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("tool-plan-delta"),
    delta: Schema.Struct({ message: Schema.Struct({ tool_plan: Schema.String }) }),
  }),
  Schema.Struct({
    type: Schema.Literals(["tool-call-start", "tool-call-delta"]),
    index: Schema.optional(Schema.Number),
    delta: Schema.Struct({
      message: Schema.Struct({
        tool_calls: Schema.Struct({
          id: Schema.optional(Schema.String),
          function: Schema.Struct({ name: Schema.optional(Schema.String), arguments: Schema.optional(Schema.String) }),
        }),
      }),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("tool-call-end"), index: Schema.optional(Schema.Number) }),
  Schema.Struct({
    type: Schema.Literal("message-end"),
    delta: Schema.Struct({ finish_reason: Schema.String, usage: Schema.optional(NativeUsage) }),
  }),
  // Citation output is outside this basic chat surface.
  Schema.Struct({ type: Schema.Literals(["citation-start", "citation-end"]) }),
])
type Event = typeof Event.Type
type State = {
  readonly lifecycle: Lifecycle.State
  readonly tools: ToolStream.State<number>
  readonly toolIndex: number
  readonly finished: boolean
}

const fromRequest = Effect.fn("CohereChat.fromRequest")(function* (request: LLMRequest) {
  const options = yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(Options))(request.providerOptions ?? {})
  const flattened = ProviderShared.flattenToolRequest(request)
  const messages: (typeof Message.Type)[] = request.system.length
    ? [{ role: "system", content: ProviderShared.joinText(request.system) }]
    : []
  for (const message of flattened.request.messages) {
    if (message.role === "system") {
      const update = yield* ProviderShared.wrappedSystemUpdate("Cohere Chat", message)
      messages.push({ role: "user", content: update.text })
      continue
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result")
          return yield* ProviderShared.unsupportedContent("Cohere Chat", "tool", ["tool-result"])
        if (part.result.type === "content" && part.result.value.some((item) => item.type === "file"))
          return yield* ProviderShared.invalidRequest("Cohere Chat does not support file content in tool results")
        messages.push({ role: "tool", tool_call_id: part.id, content: ProviderShared.toolResultText(part) })
      }
      continue
    }
    const content: (typeof Content.Type)[] = []
    const calls: (typeof ToolCall.Type)[] = []
    const plans: string[] = []
    for (const part of message.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text })
        continue
      }
      if (message.role === "assistant" && part.type === "reasoning") {
        if (part.providerMetadata?.cohere?.toolPlan === true) plans.push(part.text)
        else content.push({ type: "thinking", thinking: part.text })
        continue
      }
      if (message.role === "assistant" && part.type === "tool-call") {
        calls.push({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: ProviderShared.encodeJson(part.input) },
        })
        continue
      }
      if (message.role === "user" && part.type === "media" && part.media.mediaType.startsWith("image/")) {
        const url =
          ProviderShared.mediaUrl(part.media) ??
          (yield* ProviderShared.requireInlineMedia("Cohere Chat", part.media)).dataUrl
        content.push({ type: "image_url", image_url: { url } })
        continue
      }
      return yield* ProviderShared.unsupportedContent(
        "Cohere Chat",
        message.role,
        message.role === "user" ? ["text", "media"] : ["text", "reasoning", "tool-call"],
      )
    }
    messages.push({
      role: message.role,
      content: content.length ? content : undefined,
      tool_calls: calls.length ? calls : undefined,
      tool_plan: plans.length ? plans.join("") : undefined,
    })
  }
  const selected = request.toolChoice?.type === "tool" ? request.toolChoice.name : undefined
  const tools = selected ? flattened.tools.filter((tool) => tool.name === selected) : flattened.tools
  if (request.toolChoice?.type === "tool" && (!selected || tools.length === 0))
    return yield* ProviderShared.invalidRequest("Cohere Chat tool choice must name an available tool")
  if (tools.some((tool) => tool.native !== undefined))
    return yield* ProviderShared.invalidRequest("Cohere Chat does not support provider-defined tools")
  return {
    model: request.model.id,
    messages,
    stream: true as const,
    tools: tools.length
      ? tools.map((tool) => ({
          type: "function" as const,
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        }))
      : undefined,
    tool_choice:
      request.toolChoice?.type === "none"
        ? ("NONE" as const)
        : request.toolChoice?.type === "required" || selected
          ? ("REQUIRED" as const)
          : undefined,
    thinking: options.thinking
      ? { type: options.thinking.type ?? "enabled", token_budget: options.thinking.tokenBudget }
      : undefined,
    max_tokens: request.generation?.maxTokens,
    temperature: request.generation?.temperature,
    p: request.generation?.topP,
    k: request.generation?.topK,
    seed: request.generation?.seed,
    stop_sequences: request.generation?.stop,
    frequency_penalty: request.generation?.frequencyPenalty,
    presence_penalty: request.generation?.presencePenalty,
  }
})

const finishReason = (raw: string): FinishReasonDetails => ({
  normalized:
    raw === "COMPLETE" || raw === "STOP_SEQUENCE"
      ? "stop"
      : raw === "MAX_TOKENS"
        ? "length"
        : raw === "TOOL_CALL"
          ? "tool-calls"
          : raw === "ERROR" || raw === "TIMEOUT"
            ? "error"
            : "unknown",
  raw,
})
const mapUsage = (usage: typeof NativeUsage.Type | undefined) =>
  usage
    ? new Usage({
        inputTokens: usage.tokens?.input_tokens,
        outputTokens: usage.tokens?.output_tokens,
        nonCachedInputTokens: ProviderShared.subtractTokens(usage.tokens?.input_tokens, usage.cached_tokens),
        cacheReadInputTokens: usage.cached_tokens,
        reasoningTokens: usage.tokens?.reasoning_tokens,
        totalTokens: ProviderShared.totalTokens(usage.tokens?.input_tokens, usage.tokens?.output_tokens, undefined),
        providerMetadata: { cohere: usage },
      })
    : undefined

const step = Effect.fn("CohereChat.step")(function* (state: State, event: Event) {
  const events: LLMEvent[] = []
  switch (event.type) {
    case "message-start":
      return [{ ...state, lifecycle: Lifecycle.stepStart(state.lifecycle, events) }, events] as const
    case "content-start":
    case "content-delta": {
      const id = String(event.index)
      const content = event.delta.message.content
      const thinking = content.type === "thinking" || content.thinking !== undefined
      const text = thinking ? content.thinking : content.text
      const lifecycle =
        event.type === "content-start"
          ? thinking
            ? Lifecycle.reasoningStart(state.lifecycle, events, id)
            : Lifecycle.textStart(state.lifecycle, events, id)
          : thinking
            ? Lifecycle.reasoningDelta(state.lifecycle, events, id, text ?? "")
            : Lifecycle.textDelta(state.lifecycle, events, id, text ?? "")
      return [{ ...state, lifecycle }, events] as const
    }
    case "content-end": {
      const id = String(event.index)
      return [
        {
          ...state,
          lifecycle: state.lifecycle.reasoning.has(id)
            ? Lifecycle.reasoningEnd(state.lifecycle, events, id)
            : Lifecycle.textEnd(state.lifecycle, events, id),
        },
        events,
      ] as const
    }
    case "tool-plan-delta":
      return [
        {
          ...state,
          lifecycle: Lifecycle.reasoningDelta(state.lifecycle, events, "tool-plan", event.delta.message.tool_plan, {
            cohere: { toolPlan: true },
          }),
        },
        events,
      ] as const
    case "tool-call-start": {
      const index = event.index ?? 0
      const call = event.delta.message.tool_calls
      const result = ToolStream.appendOrStart(
        ADAPTER,
        state.tools,
        index,
        { id: call.id, name: call.function.name, text: call.function.arguments ?? "" },
        "Cohere tool start is missing id or name",
      )
      if (ToolStream.isError(result)) return yield* result
      return [
        { ...state, toolIndex: index, tools: result.tools, lifecycle: Lifecycle.stepStart(state.lifecycle, events) },
        [...events, ...result.events],
      ] as const
    }
    case "tool-call-delta": {
      const result = ToolStream.appendExisting(
        ADAPTER,
        state.tools,
        event.index ?? state.toolIndex,
        event.delta.message.tool_calls.function.arguments ?? "",
        "Cohere tool delta arrived without a start",
      )
      if (ToolStream.isError(result)) return yield* result
      return [{ ...state, tools: result.tools }, result.events] as const
    }
    case "tool-call-end": {
      const result = yield* ToolStream.finish(ADAPTER, state.tools, event.index ?? state.toolIndex)
      return [{ ...state, tools: result.tools }, result.events ?? []] as const
    }
    case "message-end": {
      const pending = yield* ToolStream.finishAll(ADAPTER, state.tools)
      events.push(...pending.events)
      const lifecycle = Lifecycle.finish(state.lifecycle, events, {
        reason: finishReason(event.delta.finish_reason),
        usage: mapUsage(event.delta.usage),
      })
      return [{ ...state, tools: pending.tools, lifecycle, finished: true }, events] as const
    }
    default:
      return [state, events] as const
  }
})

export const protocol = Protocol.make({
  id: ADAPTER,
  body: { schema: Body, from: fromRequest },
  stream: {
    event: Protocol.jsonEvent(Event),
    initial: (): State => ({
      lifecycle: Lifecycle.initial(),
      tools: ToolStream.empty(),
      toolIndex: 0,
      finished: false,
    }),
    step,
    terminal: (event) => event.type === "message-end",
    onHalt: (state) =>
      state.finished
        ? Effect.succeed([])
        : Effect.fail(ProviderShared.eventError(ADAPTER, "Cohere stream ended without message-end")),
  },
})
export const route = Route.make({
  id: ADAPTER,
  provider: "cohere",
  providerMetadataKey: "cohere",
  protocol,
  endpoint: Endpoint.path("/chat", { baseURL: DEFAULT_BASE_URL }),
  framing: Framing.sse,
})
export * as CohereChat from "./cohere-chat.js"
