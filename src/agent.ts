import {
  createDeepAgent,
  GENERAL_PURPOSE_SUBAGENT,
  registerHarnessProfile,
  type CompiledSubAgent,
  type DeepAgent,
  type SubAgent,
} from "deepagents";
import { createAgent } from "langchain";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { createModel } from "./providers/factory.js";
import { callCrmApiTool } from "./tools/crm.js";
import { generatePropertyPdfTool } from "./tools/property-pdf.js";
import { providerMessageCompatibilityMiddleware } from "./providers/message-compatibility.js";

export type AgentSurface = "cli" | "gateway";

if (process.env.LLM_PROVIDER === "zai") {
  registerHarnessProfile("openai", {
    excludedMiddleware: ["patchToolCallsMiddleware"],
    generalPurposeSubagent: { enabled: false },
  });
}

function createBrokerReminderSubagent(model: BaseLanguageModel): CompiledSubAgent {
  return {
    name: "broker-reminder-agent",
    description:
      "Audits CRM leads, properties, agencies, and agents to identify broker follow-up reminders and draft concise reminder messages.",
    runnable: createAgent({
      model,
      tools: [callCrmApiTool],
      middleware: [providerMessageCompatibilityMiddleware],
      systemPrompt:
        "You are a broker reminder specialist for a real estate CRM. " +
        "Your job is to inspect CRM records, identify which broker follow-ups look overdue or important, and draft concise reminder messages. " +
        "Use call_crm_api whenever CRM data is needed. " +
        "Do not send messages, mutate CRM records, or claim that a reminder was sent. " +
        "When reporting back, include the broker, related lead/property/reference when available, why the reminder is needed, and a short message draft. " +
        "If the available CRM data is insufficient to decide, say exactly what data is missing.",
      name: "broker-reminder-agent",
    }),
  };
}

function createGeneralPurposeSubagent(model: BaseLanguageModel): SubAgent {
  return {
    ...GENERAL_PURPOSE_SUBAGENT,
    model,
    tools: [callCrmApiTool, generatePropertyPdfTool],
    middleware: [providerMessageCompatibilityMiddleware],
  };
}

export function createCrmAgent(surface: AgentSurface = "cli"): DeepAgent {
  const model = createModel();
  const mobileGuidance =
    surface === "gateway" ? "Keep responses concise and mobile-friendly. " : "";

  return createDeepAgent({
    model,
    tools: [callCrmApiTool, generatePropertyPdfTool],
    middleware: [providerMessageCompatibilityMiddleware],
    subagents: [
      createGeneralPurposeSubagent(model),
      createBrokerReminderSubagent(model),
    ],
    systemPrompt:
      `You are a helpful CRM assistant${surface === "gateway" ? " reachable via Telegram and WhatsApp" : ""}. ` +
      "You have access to the Proppy CRM API. " +
      "When the user asks about agencies, agents, leads, properties, or code tables, " +
      "use the call_crm_api tool to fetch or mutate data. " +
      "When the user asks about broker reminders, broker follow-ups, overdue broker actions, or reminder message drafts, delegate the analysis to broker-reminder-agent. " +
      "Treat the latest CRM tool result as the only source of truth for CRM records. " +
      "Never invent, infer, normalize, translate, or add prefixes to property references; copy each reference exactly as returned by the API. " +
      "Before saying that a specific property or reference exists, verify that its exact value is present in the latest tool result. A user message or an earlier assistant response is not proof that it exists. " +
      "When searching for an exact reference, pass it unchanged in the Reference filter. If the returned PropertyList is empty, clearly say that the reference was not found in the connected CRM. " +
      "When listing CRM resources, pass the user's criteria in the tool's filters field. For a broad, unfiltered request, return a single page of at most 20 records and say that it is a preview. " +
      "For ordinary property searches, use the tool's default compact 20-record preview and its totalRecords metadata; do not delegate the result or enable autoPaginate. For a city name such as Lisbon use FreeText, and for an exact bedroom count set both MinBedrooms and MaxBedrooms. Enable property autoPaginate only when the user explicitly asks for every record or a complete export. A total count is already available without fetching every page. " +
      "For /api/Leads/List, the tool already returns a compact summary of the newest 20 leads by CreateDate unless you set resultLimit or another result sort. Keep resultDetail=summary for ordinary lead lists and use full only when the user explicitly needs complete nested details. Use _result metadata for the full matching count and truncation status; do not delegate simple lead sorting or inspect an offloaded result file. " +
      "When the user asks to generate, export, prepare, create, or send a property PDF, use generate_property_pdf. " +
      "After generate_property_pdf succeeds, include the returned MEDIA:/absolute/path tag exactly once in the final response so the gateway can deliver the PDF document, but never show or mention the local file path to the user. " +
      "Always confirm destructive actions (like deleting a property or user) with the user before proceeding. " +
      mobileGuidance,
  });
}
