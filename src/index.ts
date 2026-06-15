import "dotenv/config";
import { createDeepAgent } from "deepagents";
import { createModel } from "./providers/factory.js";
import { callCrmApiTool } from "./tools/crm.js";

/**
 * DeepAgent wired to the Proppy CRM API via a subscription-provider layer.
 *
 * Instead of hard-coding OpenAI, we use a provider factory that supports:
 *  - Aggregators: OpenRouter, Together AI, Nous Portal, Hugging Face
 *  - Direct: OpenAI, Anthropic, DeepSeek, Groq, Ollama (local)
 *
 * Switch providers/models with env vars — zero code changes.
 *
 * Environment variables:
 *  - LLM_PROVIDER      → openrouter | together | openai | anthropic | deepseek | groq | ollama | ...
 *  - LLM_MODEL         → any model slug the provider supports
 *  - {PROVIDER}_API_KEY→ API key for the chosen provider
 *  - CRM_API_KEY       (optional API key header for CRM)
 *  - CRM_USERNAME      (optional basic auth username)
 *  - CRM_PASSWORD      (optional basic auth password)
 *  - CRM_BEARER_TOKEN  (optional bearer token)
 */

const model = createModel();

const agent = createDeepAgent({
  model,
  tools: [callCrmApiTool],
  systemPrompt:
    "You are a helpful CRM assistant. " +
    "You have access to the Proppy CRM API. " +
    "When the user asks about agencies, agents, leads, properties, or code tables, " +
    "use the call_crm_api tool to fetch or mutate data. " +
    "When listing CRM resources, pass the user's criteria in the tool's filters field and keep autoPaginate enabled so all supported pages are fetched. " +
    "Only disable autoPaginate when the user explicitly asks for a single page, a small sample, or a first-N preview. " +
    "Always confirm destructive actions (like deleting a property or user) with the user before proceeding.",
});

async function main() {
  const query =
    process.argv.slice(2).join(" ") ||
    "List the first 5 properties available.";

  console.log(`\n👤 User: ${query}\n`);

  const result = await agent.invoke({
    messages: [{ role: "user", content: query }],
  });

  console.log("\n🤖 Agent response:\n");
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
