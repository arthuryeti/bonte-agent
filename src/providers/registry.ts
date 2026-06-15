import type { ProviderConfig } from "./types.js";

/**
 * Provider registry — single source of truth for supported LLM providers.
 *
 * Aggregators (isAggregator = true) let you switch models without
 * changing provider config. You only need one API key to access
 * 200+ models via OpenRouter, or dozens via Together / Nous Portal.
 */

export const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  // ── Aggregators (subscription / multi-model providers) ──

  openrouter: {
    name: "openrouter",
    displayName: "OpenRouter",
    transport: "openai_chat",
    isAggregator: true,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    baseUrlEnvVar: "OPENROUTER_BASE_URL",
    extraHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_REFERER || "",
      "X-Title": process.env.OPENROUTER_APP_NAME || "CRM DeepAgent",
    },
    defaultModel: "openai/gpt-4o",
  },

  together: {
    name: "together",
    displayName: "Together AI",
    transport: "openai_chat",
    isAggregator: true,
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnvVar: "TOGETHER_API_KEY",
    baseUrlEnvVar: "TOGETHER_BASE_URL",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },

  nous: {
    name: "nous",
    displayName: "Nous Portal",
    transport: "openai_chat",
    isAggregator: true,
    baseUrl: "https://inference-api.nousresearch.com/v1",
    apiKeyEnvVar: "NOUS_API_KEY",
    baseUrlEnvVar: "NOUS_BASE_URL",
    defaultModel: "nous-hermes-2-mixtral",
  },

  huggingface: {
    name: "huggingface",
    displayName: "Hugging Face Inference",
    transport: "openai_chat",
    isAggregator: true,
    baseUrl: "https://api-inference.huggingface.co/v1",
    apiKeyEnvVar: "HF_API_KEY",
    baseUrlEnvVar: "HF_BASE_URL",
    defaultModel: "meta-llama/Meta-Llama-3-70B-Instruct",
  },

  // ── Direct providers ──

  openai: {
    name: "openai",
    displayName: "OpenAI",
    transport: "openai_chat",
    isAggregator: false,
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
    baseUrlEnvVar: "OPENAI_BASE_URL",
    defaultModel: "gpt-4o",
  },

  anthropic: {
    name: "anthropic",
    displayName: "Anthropic",
    transport: "anthropic_messages",
    isAggregator: false,
    baseUrl: "https://api.anthropic.com",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    baseUrlEnvVar: "ANTHROPIC_BASE_URL",
    defaultModel: "claude-sonnet-4-5-20250929",
  },

  deepseek: {
    name: "deepseek",
    displayName: "DeepSeek",
    transport: "openai_chat",
    isAggregator: false,
    baseUrl: "https://api.deepseek.com",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    baseUrlEnvVar: "DEEPSEEK_BASE_URL",
    defaultModel: "deepseek-chat",
  },

  groq: {
    name: "groq",
    displayName: "Groq",
    transport: "openai_chat",
    isAggregator: false,
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    baseUrlEnvVar: "GROQ_BASE_URL",
    defaultModel: "llama-3.3-70b-versatile",
  },

  ollama: {
    name: "ollama",
    displayName: "Ollama (local)",
    transport: "openai_chat",
    isAggregator: false,
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnvVar: "OLLAMA_API_KEY", // usually "ollama" or empty
    baseUrlEnvVar: "OLLAMA_BASE_URL",
    defaultModel: "llama3.2",
  },

  zai: {
    name: "zai",
    displayName: "Z.AI / GLM (Zhipu AI)",
    transport: "openai_chat",
    isAggregator: false,
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnvVar: "ZAI_API_KEY",
    baseUrlEnvVar: "ZAI_BASE_URL",
    defaultModel: "GLM-4.5-air",
  },

  kimi: {
    name: "kimi",
    displayName: "Kimi (Moonshot AI)",
    transport: "openai_chat",
    isAggregator: false,
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnvVar: "KIMI_API_KEY",
    baseUrlEnvVar: "KIMI_BASE_URL",
    defaultModel: "kimi-k2-latest",
  },
};

/** List of aggregator provider names. */
export const AGGREGATOR_NAMES = Object.values(PROVIDER_REGISTRY)
  .filter((p) => p.isAggregator)
  .map((p) => p.name);

/** List of all provider names. */
export const ALL_PROVIDER_NAMES = Object.keys(PROVIDER_REGISTRY);
