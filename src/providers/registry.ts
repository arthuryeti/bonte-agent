import type {
  ProviderConfig,
  ProviderRuntimeContext,
  ProviderRuntimeOverrides,
} from "./types.js";

export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding";

function isKimiCodeBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.kimi.com" &&
      (url.port === "" || url.port === "443") &&
      (path === "/coding" || path === "/coding/v1") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function resolveKimiRuntime({
  apiKey,
  baseUrlOverride,
}: ProviderRuntimeContext): ProviderRuntimeOverrides {
  const baseUrl =
    baseUrlOverride ||
    (apiKey.startsWith("sk-kimi-")
      ? KIMI_CODE_BASE_URL
      : "https://api.moonshot.ai/v1");

  if (isKimiCodeBaseUrl(baseUrl)) {
    return {
      // The Anthropic SDK appends /v1/messages, so its base URL must not
      // retain the OpenAI-compatible /v1 suffix.
      baseUrl: KIMI_CODE_BASE_URL,
      transport: "anthropic_messages",
      defaultModel: "k3",
    };
  }

  return {
    baseUrl,
    transport: "openai_chat",
    defaultModel: "kimi-k2-latest",
  };
}

const kimiCodingProvider: ProviderConfig = {
  name: "kimi-coding",
  transport: "openai_chat",
  baseUrl: "https://api.moonshot.ai/v1",
  apiKeyEnvVar: "KIMI_API_KEY",
  apiKeyEnvVarAliases: ["KIMI_CODING_API_KEY"],
  baseUrlEnvVar: "KIMI_BASE_URL",
  extraHeaders: {
    "User-Agent": "crm-deepagent/0.1.0",
  },
  defaultModel: "kimi-k2-latest",
  maxTokens: 32_000,
  omitTemperature: true,
  streaming: true,
  resolveRuntime: resolveKimiRuntime,
};

/**
 * Provider registry — single source of truth for supported LLM providers.
 */

export const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  // ── Aggregators (subscription / multi-model providers) ──

  openrouter: {
    name: "openrouter",
    transport: "openai_chat",
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
    transport: "openai_chat",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnvVar: "TOGETHER_API_KEY",
    baseUrlEnvVar: "TOGETHER_BASE_URL",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },

  nous: {
    name: "nous",
    transport: "openai_chat",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    apiKeyEnvVar: "NOUS_API_KEY",
    baseUrlEnvVar: "NOUS_BASE_URL",
    defaultModel: "nous-hermes-2-mixtral",
  },

  huggingface: {
    name: "huggingface",
    transport: "openai_chat",
    baseUrl: "https://api-inference.huggingface.co/v1",
    apiKeyEnvVar: "HF_API_KEY",
    baseUrlEnvVar: "HF_BASE_URL",
    defaultModel: "meta-llama/Meta-Llama-3-70B-Instruct",
  },

  surplus: {
    name: "surplus",
    transport: "openai_chat",
    baseUrl: "https://api.surplusintelligence.ai/v1",
    apiKeyEnvVar: "SURPLUS_API_KEY",
    baseUrlEnvVar: "SURPLUS_BASE_URL",
    defaultModel: "claude-opus-5",
    // Match Surplus's OpenAI-compatible example request exactly.
    omitTemperature: true,
    // Some marketplace sellers omit delta.role in every SSE chunk.
    defaultStreamingRole: "assistant",
  },

  // ── Direct providers ──

  openai: {
    name: "openai",
    transport: "openai_chat",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
    baseUrlEnvVar: "OPENAI_BASE_URL",
    defaultModel: "gpt-4o",
  },

  anthropic: {
    name: "anthropic",
    transport: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    baseUrlEnvVar: "ANTHROPIC_BASE_URL",
    defaultModel: "claude-sonnet-4-5-20250929",
  },

  deepseek: {
    name: "deepseek",
    transport: "openai_chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    baseUrlEnvVar: "DEEPSEEK_BASE_URL",
    defaultModel: "deepseek-chat",
  },

  groq: {
    name: "groq",
    transport: "openai_chat",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    baseUrlEnvVar: "GROQ_BASE_URL",
    defaultModel: "llama-3.3-70b-versatile",
  },

  ollama: {
    name: "ollama",
    transport: "openai_chat",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnvVar: "OLLAMA_API_KEY", // usually "ollama" or empty
    baseUrlEnvVar: "OLLAMA_BASE_URL",
    defaultModel: "llama3.2",
  },

  zai: {
    name: "zai",
    transport: "openai_chat",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnvVar: "ZAI_API_KEY",
    baseUrlEnvVar: "ZAI_BASE_URL",
    defaultModel: "GLM-4.5-air",
  },

  "kimi-coding": kimiCodingProvider,
  kimi: kimiCodingProvider,
  moonshot: kimiCodingProvider,
};

