import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import {
  createLanguageModel,
  resolveProvider,
} from "../src/providers/factory.js";

const ENV_KEYS = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "KIMI_API_KEY",
  "KIMI_CODING_API_KEY",
  "KIMI_BASE_URL",
] as const;

const originalEnv = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]] as const)
);

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Kimi provider", () => {
  it("auto-routes Kimi Code keys to K3 over Anthropic Messages", () => {
    process.env.LLM_PROVIDER = "kimi";
    process.env.KIMI_API_KEY = "sk-kimi-test";

    const resolved = resolveProvider();

    assert.equal(resolved.config.name, "kimi-coding");
    assert.equal(resolved.baseUrl, "https://api.kimi.com/coding");
    assert.equal(resolved.transport, "anthropic_messages");
    assert.equal(resolved.model, "k3");
    const model = createLanguageModel(resolved);
    assert.ok(model instanceof ChatAnthropic);
    assert.equal(model.temperature, undefined);
    assert.equal(model.maxTokens, 32_000);
    assert.equal(model.streaming, true);
    assert.equal(
      model.clientOptions.defaultHeaders?.["User-Agent"],
      "crm-deepagent/0.1.0"
    );
  });

  it("keeps legacy Moonshot keys on OpenAI chat completions", () => {
    process.env.LLM_PROVIDER = "moonshot";
    process.env.KIMI_API_KEY = "legacy-test-key";

    const resolved = resolveProvider();

    assert.equal(resolved.baseUrl, "https://api.moonshot.ai/v1");
    assert.equal(resolved.transport, "openai_chat");
    assert.equal(resolved.model, "kimi-k2-latest");
    const model = createLanguageModel(resolved);
    assert.ok(model instanceof ChatOpenAI);
    assert.equal(model.temperature, undefined);
  });

  it("honors explicit endpoint and model overrides", () => {
    process.env.LLM_PROVIDER = "kimi-coding";
    process.env.KIMI_CODING_API_KEY = "test-key";
    process.env.KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
    process.env.LLM_MODEL = "k3-256k";

    const resolved = resolveProvider();

    assert.equal(resolved.baseUrl, "https://api.kimi.com/coding");
    assert.equal(resolved.transport, "anthropic_messages");
    assert.equal(resolved.model, "k3-256k");
  });
});
