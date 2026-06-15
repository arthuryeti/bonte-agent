/**
 * Provider type system inspired by Hermes Agent.
 *
 * Instead of calling OpenAI/Anthropic directly, we route through
 * subscription aggregators (OpenRouter, Together, etc.) or direct providers.
 *
 * Transport types:
 *  - "openai_chat"      → @langchain/openai ChatOpenAI (OpenAI-compatible API)
 *  - "anthropic_messages" → @langchain/anthropic ChatAnthropic
 *
 * Aggregators expose many models behind a single endpoint + API key.
 */

export type TransportType = "openai_chat" | "anthropic_messages";

export interface ProviderConfig {
  /** Unique provider key, e.g. "openrouter", "openai", "anthropic" */
  name: string;
  /** Human-readable name */
  displayName: string;
  /** How we talk to the provider */
  transport: TransportType;
  /** True if this provider proxies many underlying models (OpenRouter, Together, etc.) */
  isAggregator: boolean;
  /** Default base URL. Can be overridden via env var. */
  baseUrl: string;
  /** Env var that holds the API key */
  apiKeyEnvVar: string;
  /** Env var that can override baseUrl */
  baseUrlEnvVar?: string;
  /** Extra headers to send with every request (for aggregators) */
  extraHeaders?: Record<string, string>;
  /** Default model when none is specified */
  defaultModel?: string;
}

export interface ResolvedProvider {
  config: ProviderConfig;
  apiKey: string;
  baseUrl: string;
  model: string;
}
