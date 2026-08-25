import { ChatOpenAI, ChatOpenAICompletions } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { OpenAI } from "openai";
import { PROVIDER_REGISTRY } from "./registry.js";
import type { ResolvedProvider } from "./types.js";

/**
 * OpenAI-compatible gateways occasionally omit `delta.role` from their SSE
 * stream. OpenAI's converter treats such chunks as generic chat messages,
 * which agents reject. Providers opt into this fallback explicitly.
 */
class DefaultRoleChatOpenAICompletions extends ChatOpenAICompletions {
  constructor(
    fields: ConstructorParameters<typeof ChatOpenAICompletions>[0],
    private readonly defaultStreamingRole: "assistant"
  ) {
    super(fields);
  }

  protected override _convertCompletionsDeltaToBaseMessageChunk(
    delta: Record<string, unknown>,
    rawResponse: OpenAI.Chat.Completions.ChatCompletionChunk,
    defaultRole?: OpenAI.Chat.ChatCompletionRole
  ) {
    return super._convertCompletionsDeltaToBaseMessageChunk(
      delta,
      rawResponse,
      defaultRole ?? this.defaultStreamingRole
    );
  }
}

/**
 * Resolve a provider from environment variables.
 *
 * Reads:
 *  - LLM_PROVIDER      → which provider config to use (default: "openai")
 *  - LLM_MODEL         → which model to request (default: provider's defaultModel)
 *  - {Provider}_API_KEY → API key for the chosen provider
 *  - {Provider}_BASE_URL → optional override for the provider's endpoint
 *
 * Examples:
 *  LLM_PROVIDER=openrouter LLM_MODEL=anthropic/claude-sonnet-4-5-20250929
 *  LLM_PROVIDER=together   LLM_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
 *  LLM_PROVIDER=openai     LLM_MODEL=gpt-4o-mini
 */
export function resolveProvider(): ResolvedProvider {
  const providerName = process.env.LLM_PROVIDER ?? "openai";
  const config = PROVIDER_REGISTRY[providerName];

  if (!config) {
    const known = Object.keys(PROVIDER_REGISTRY).join(", ");
    throw new Error(
      `Unknown provider "${providerName}". Known providers: ${known}`
    );
  }

  const apiKeyEnvVars = [
    config.apiKeyEnvVar,
    ...(config.apiKeyEnvVarAliases ?? []),
  ];
  const apiKey = apiKeyEnvVars
    .map((envVar) => process.env[envVar])
    .find((value): value is string => Boolean(value));
  if (!apiKey) {
    throw new Error(
      `Provider "${providerName}" requires API key in env var ${apiKeyEnvVars.join(" or ")}`
    );
  }

  const baseUrlOverride =
    config.baseUrlEnvVar && process.env[config.baseUrlEnvVar]
      ? process.env[config.baseUrlEnvVar]
      : undefined;
  const runtime = config.resolveRuntime?.({ apiKey, baseUrlOverride });
  const baseUrl = runtime?.baseUrl ?? baseUrlOverride ?? config.baseUrl;
  const transport = runtime?.transport ?? config.transport;

  const model =
    process.env.LLM_MODEL ??
    runtime?.defaultModel ??
    config.defaultModel ??
    "";

  return { config, apiKey, baseUrl, model, transport };
}

export function describeResolvedProvider(
  resolved: ResolvedProvider = resolveProvider()
): string {
  return [
    `provider=${resolved.config.name}`,
    `model=${resolved.model}`,
    `transport=${resolved.transport}`,
    `baseURL=${resolved.baseUrl}`,
  ].join(" ");
}

/**
 * Build a LangChain model instance from a resolved provider.
 *
 * This is the core of the subscription-provider pattern:
 * one factory, many backends, zero code changes when switching.
 */
export function createLanguageModel(resolved?: ResolvedProvider): BaseLanguageModel {
  const { config, apiKey, baseUrl, model, transport } =
    resolved ?? resolveProvider();
  const temperature = config.omitTemperature
    ? {}
    : { temperature: 0.2 };

  switch (transport) {
    case "openai_chat": {
      const fields = {
        model,
        apiKey,
        maxTokens: config.maxTokens,
        streaming: config.streaming,
        configuration: {
          baseURL: baseUrl,
          defaultHeaders: config.extraHeaders,
        },
        ...temperature,
      };

      return new ChatOpenAI({
        ...fields,
        ...(config.defaultStreamingRole
          ? {
              completions: new DefaultRoleChatOpenAICompletions(
                fields,
                config.defaultStreamingRole
              ),
            }
          : {}),
      });
    }

    case "anthropic_messages": {
      return new ChatAnthropic({
        model,
        apiKey,
        anthropicApiUrl: baseUrl,
        maxTokens: config.maxTokens,
        streaming: config.streaming,
        clientOptions: {
          defaultHeaders: config.extraHeaders,
        },
        ...temperature,
      });
    }

    default:
      throw new Error(
        `Unsupported transport "${transport satisfies never}" for provider "${config.name}"`
      );
  }
}

/**
 * Convenience helper: resolve provider + build model in one call.
 */
export function createModel(): BaseLanguageModel {
  return createLanguageModel();
}
