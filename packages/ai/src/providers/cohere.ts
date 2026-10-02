import { CohereChat } from "../protocols/cohere-chat.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { ProviderID, type ModelID, type OpenString } from "../schema/index.js"
import type { ProviderPackage } from "../provider-package.js"

export const id = ProviderID.make("cohere")
export type ProviderOptions = CohereChat.ProviderOptionsInput & {
  readonly reasoningEffort?: OpenString<"none" | "high">
}
export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: ProviderOptions
  }
export type Settings = ProviderPackage.Settings &
  ProviderOptions & { readonly apiKey?: string; readonly baseURL?: string }

export const route = CohereChat.route
export const chatRoute = Route.make({
  id: "cohere-chat-completions",
  provider: id,
  providerMetadataKey: "cohere",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: "https://api.cohere.ai/compatibility/v1" }),
  framing: OpenAIChat.framing,
})
export const routes = [route, chatRoute]

export const configure = (input: LanguageModelOptions = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL, ...defaults } = input
  const auth = AuthOptions.bearer(input, "COHERE_API_KEY")
  const native = route.with({ ...defaults, auth, endpoint: { baseURL: baseURL ?? CohereChat.DEFAULT_BASE_URL } })
  const chat = chatRoute.with({
    ...defaults,
    auth,
    endpoint: { baseURL: baseURL ?? "https://api.cohere.ai/compatibility/v1" },
  })
  return {
    id,
    model: (modelID: string | ModelID) => native.model<CohereChat.ProviderOptionsInput>({ id: modelID }),
    chat: (modelID: string | ModelID) =>
      chat.model<{ readonly reasoningEffort?: OpenString<"none" | "high"> }>({
        id: modelID,
        compatibility: {
          maxTokensField: "max_tokens",
          supportsStore: false,
          supportsUsageInStreaming: true,
          reasoningField: "reasoning_content",
          supportsStrictMode: false,
        },
      }),
    configure,
  }
}
export const provider = configure()
export const model: ProviderPackage.Definition<Settings, CohereChat.ProviderOptionsInput>["model"] = (
  modelID,
  { apiKey, baseURL, body, headers, ...providerOptions },
) =>
  configure({
    apiKey,
    baseURL,
    headers,
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).model(modelID)
export * as Cohere from "./cohere.js"
