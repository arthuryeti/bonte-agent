import type {
  CrmToolStatusView,
  LeadListView,
  PropertyListView,
} from "../../chat-types";
import type { GatewayEvent } from "./gateway-client";

export const CRM_TOOL_NAME = "call_crm_api";
export const SPECIALIST_TOOL_NAME = "task";
export const PROPERTY_PDF_TOOL_NAME = "generate_property_pdf";

const LEAD_LIST_ENDPOINT = "/api/Leads/List";
const PROPERTY_LIST_ENDPOINT = "/api/Property/ListProperties";

export interface GatewayHistoryDataPart {
  type?: string;
  id?: string;
  data?: unknown;
}

export interface GatewayHistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  platform_message_id?: string;
  data_parts?: GatewayHistoryDataPart[];
}

export interface ToolStatusPart {
  type: "data-tool-status";
  id: string;
  data: CrmToolStatusView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function payloadString(event: GatewayEvent, key: string): string {
  const value = event.payload?.[key];
  return typeof value === "string" ? value : "";
}

function toolStartLabel(toolName: string, endpoint: string): string {
  if (toolName === SPECIALIST_TOOL_NAME) return "Specialist agent is working…";
  if (toolName === PROPERTY_PDF_TOOL_NAME) return "Preparing the property document…";
  if (endpoint === LEAD_LIST_ENDPOINT) return "Fetching latest leads…";
  if (endpoint === PROPERTY_LIST_ENDPOINT) return "Fetching properties…";
  return "Fetching CRM data…";
}

function toolErrorLabel(toolName: string, message: string): string {
  if (toolName === SPECIALIST_TOOL_NAME) {
    return "The specialist agent could not complete its analysis.";
  }
  if (toolName === PROPERTY_PDF_TOOL_NAME) {
    return "The property document could not be prepared.";
  }
  if (/403|blocked|security service/i.test(message)) {
    return "CRM access was blocked. Check the CRM security or API access settings.";
  }
  if (/401|unauthori[sz]ed|authentication/i.test(message)) {
    return "CRM authentication failed. Check the configured CRM credentials.";
  }
  return "CRM request failed. Please try again.";
}

function isVisibleTool(toolName: string): boolean {
  return (
    toolName === CRM_TOOL_NAME ||
    toolName === SPECIALIST_TOOL_NAME ||
    toolName === PROPERTY_PDF_TOOL_NAME
  );
}

export function workingStatusPart(
  id: string,
  label = "Thinking…",
): ToolStatusPart {
  return {
    type: "data-tool-status",
    id,
    data: { status: "running", label },
  };
}

/**
 * Converts gateway progress events into one replaceable working-state part.
 * Message text and structured CRM results are intentionally excluded here;
 * they are emitted from persisted history only after the turn completes.
 */
export function temporaryStatusPartForEvent(
  event: GatewayEvent,
  workingPartId: string,
): ToolStatusPart | undefined {
  if (event.type === "tool.start") {
    const toolName = payloadString(event, "tool_name");
    if (!isVisibleTool(toolName)) return undefined;
    return workingStatusPart(
      workingPartId,
      toolStartLabel(toolName, payloadString(event, "endpoint")),
    );
  }

  if (event.type === "lead.list.available") {
    return workingStatusPart(workingPartId, "Analyzing lead data…");
  }

  if (event.type === "property.list.available") {
    return workingStatusPart(workingPartId, "Analyzing property data…");
  }

  if (event.type === "attachment.available") {
    return workingStatusPart(workingPartId, "Finishing the document…");
  }

  if (event.type === "tool.complete") {
    const toolName = payloadString(event, "tool_name");
    if (!isVisibleTool(toolName)) return undefined;
    const label = toolName === SPECIALIST_TOOL_NAME
      ? "Reviewing the specialist findings…"
      : "Preparing the final response…";
    return workingStatusPart(workingPartId, label);
  }

  if (event.type === "tool.error") {
    const toolName = payloadString(event, "tool_name");
    if (!isVisibleTool(toolName)) return undefined;
    return {
      type: "data-tool-status",
      id: payloadString(event, "run_id") || workingPartId,
      data: {
        status: "error",
        label: toolErrorLabel(toolName, payloadString(event, "message")),
      },
    };
  }

  return undefined;
}

export function completedWorkingStatusPart(id: string): ToolStatusPart {
  return {
    type: "data-tool-status",
    id,
    data: { status: "complete", label: "" },
  };
}

export function persistedAssistantMessageForTurn(
  messages: GatewayHistoryMessage[],
  turnId: string,
): GatewayHistoryMessage | undefined {
  return messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.platform_message_id === `assistant:${turnId}`,
  );
}

function normalizedContent(value: string): string {
  return value.toLocaleLowerCase("en");
}

function recordMentionScore(content: string, candidates: Array<string | undefined>): number {
  const uniqueCandidates = new Set(
    candidates
      .map((candidate) => candidate?.trim())
      .filter((candidate): candidate is string => Boolean(candidate && candidate.length >= 3))
      .map(normalizedContent),
  );
  for (const candidate of uniqueCandidates) {
    if (content.includes(candidate)) return 1;
  }
  return 0;
}

function leadListMentionScore(content: string, data: LeadListView): number {
  if (!Array.isArray(data.leads)) return 0;
  return data.leads.reduce((score, lead) => score + recordMentionScore(content, [
    lead.id,
    lead.title,
    lead.contact?.name,
    ...(Array.isArray(lead.agents)
      ? lead.agents.flatMap((agent) => [agent.id, agent.name])
      : []),
    ...(Array.isArray(lead.properties)
      ? lead.properties.flatMap((property) => [property.id, property.reference])
      : []),
  ]), 0);
}

function propertyListMentionScore(content: string, data: PropertyListView): number {
  if (!Array.isArray(data.properties)) return 0;
  return data.properties.reduce((score, property) => score + recordMentionScore(content, [
    property.id,
    property.internalId,
    property.reference,
    property.title,
    property.agent?.id,
    property.agent?.name,
  ]), 0);
}

function selectMostRelevantPart(
  parts: GatewayHistoryDataPart[],
  content: string,
  type: "lead-list" | "property-list",
): GatewayHistoryDataPart | undefined {
  const matching = parts.filter((part) => part.type === type && part.id && isRecord(part.data));
  if (matching.length <= 1) return matching[0];

  const normalized = normalizedContent(content);
  let selected = matching.at(-1);
  let selectedScore = 0;
  for (const part of matching) {
    const score = type === "lead-list"
      ? leadListMentionScore(normalized, part.data as unknown as LeadListView)
      : propertyListMentionScore(normalized, part.data as unknown as PropertyListView);
    if (score > selectedScore) {
      selected = part;
      selectedScore = score;
    }
  }
  return selected;
}

/** Keep at most one clearly relevant result card of each type. */
export function selectRelevantDataParts(
  parts: GatewayHistoryDataPart[] = [],
  content: string,
): GatewayHistoryDataPart[] {
  const selected = [
    selectMostRelevantPart(parts, content, "lead-list"),
    selectMostRelevantPart(parts, content, "property-list"),
  ];
  return selected.filter((part): part is GatewayHistoryDataPart => Boolean(part));
}
