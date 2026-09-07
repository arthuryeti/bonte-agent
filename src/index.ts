import "dotenv/config";
import { createCrmAgent } from "./agent.js";
import { extractLastAssistantText } from "./agent-response.js";
import { runWithWorkflowContext } from "./workflows/context.js";
import { initializeWorkflowStore } from "./workflows/store.js";

/**
 * DeepAgent wired to the Proppy CRM API via a subscription-provider layer.
 *
 * Instead of hard-coding OpenAI, we use a provider factory that supports:
 *  - Aggregators: OpenRouter, Together AI, Nous Portal, Hugging Face, Surplus Intelligence
 *  - Direct: OpenAI, Anthropic, DeepSeek, Groq, Ollama (local)
 *
 * Switch providers/models with env vars — zero code changes.
 *
 * Environment variables:
 *  - LLM_PROVIDER      → surplus | openrouter | together | openai | anthropic | deepseek | groq | ollama | ...
 *  - LLM_MODEL         → any model slug the provider supports
 *  - {PROVIDER}_API_KEY→ API key for the chosen provider
 *  - CRM_API_KEY       (optional API key header for CRM)
 *  - CRM_USERNAME      (optional basic auth username)
 *  - CRM_PASSWORD      (optional basic auth password)
 *  - CRM_BEARER_TOKEN  (optional bearer token)
 */

const agent = createCrmAgent("cli");

async function main() {
  const query =
    process.argv.slice(2).join(" ") ||
    "List the first 5 properties available.";

  console.log(`\n👤 User: ${query}\n`);

  const store = await initializeWorkflowStore();
  const result = await runWithWorkflowContext({workspaceId:"cli-local",conversationId:"cli-local",actorId:"cli-local"}, () => agent.invoke({
    messages: [{ role: "user", content: query }],
  })).finally(() => store.close());

  console.log("\n🤖 Agent response:\n");
  console.log(
    extractLastAssistantText(result) || "The agent returned no text response."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
