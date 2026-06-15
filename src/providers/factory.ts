import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { PROVIDER_REGISTRY } from "./registry.js";
import type { ProviderConfig, ResolvedProvider } from "./types.js";

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

  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(
      `Provider "${providerName}" requires API key in env var ${config.apiKeyEnvVar}`
    );
  }

  const baseUrl =
    (config.baseUrlEnvVar && process.env[config.baseUrlEnvVar]) ||
    config.baseUrl;

  const model = process.env.LLM_MODEL ?? config.defaultModel ?? "";

  return { config, apiKey, baseUrl, model };
}

/**
 * Build a LangChain model instance from a resolved provider.
 *
 * This is the core of the subscription-provider pattern:
 * one factory, many backends, zero code changes when switching.
 */
export function createLanguageModel(resolved?: ResolvedProvider): BaseLanguageModel {
  const { config, apiKey, baseUrl, model } = resolved ?? resolveProvider();

  switch (config.transport) {
    case "openai_chat": {
      return new ChatOpenAI({
        model,
        apiKey,
        configuration: {
          baseURL: baseUrl,
          defaultHeaders: config.extraHeaders,
        },
        temperature: 0.2,
      });
    }

    case "anthropic_messages": {
      return new ChatAnthropic({
        model,
        apiKey,
        anthropicApiUrl: baseUrl,
        temperature: 0.2,
      });
    }

    default:
      throw new Error(
        `Unsupported transport "${(config as ProviderConfig).transport}" for provider "${config.name}"`
      );
  }
}

/**
 * Convenience helper: resolve provider + build model in one call.
 */
export function createModel(): BaseLanguageModel {
  return createLanguageModel();
}
