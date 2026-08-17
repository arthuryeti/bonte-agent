import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { GatewayRpcClient, type GatewayEvent } from "./gateway-client";
import type {
  CrmToolStatusView,
  CrmChatMessage,
  LeadListView,
  PropertyListView,
  ScheduleFollowUpAction,
} from "../../chat-types";
import { getAuthSession, workspaceIdForUser } from "../../../lib/auth-session";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_MESSAGE_LENGTH = 8_000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const TURN_TIMEOUT_MS = 120_000;
const GATEWAY_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const CRM_TOOL_NAME = "call_crm_api";
const LEAD_LIST_ENDPOINT = "/api/Leads/List";
const PROPERTY_LIST_ENDPOINT = "/api/Property/ListProperties";

interface ChatRequestBody {
  id?: string;
  sessionId?: string;
  messages?: CrmChatMessage[];
  action?: unknown;
}

interface GatewayHistoryDataPart {
  type?: string;
  id?: string;
  data?: unknown;
}

interface GatewayHistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  platform_message_id?: string;
  data_parts?: GatewayHistoryDataPart[];
}

interface AcceptedTurn {
  turn_id: string;
  duplicate?: boolean;
  status?: "accepted" | "running" | "complete" | "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMessageText(message: CrmChatMessage): string {
  return message.parts
    .filter((part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
      part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .slice(0, MAX_MESSAGE_LENGTH);
}

function parseScheduleFollowUpAction(value: unknown): ScheduleFollowUpAction | undefined {
  if (!isRecord(value) || value.type !== "schedule_follow_up") return undefined;
  if (
    typeof value.actionId !== "string" ||
    typeof value.leadId !== "string" ||
    typeof value.scheduledFor !== "string"
  ) {
    return undefined;
  }
  return {
    actionId: value.actionId,
    type: "schedule_follow_up",
    leadId: value.leadId,
    leadTitle: typeof value.leadTitle === "string" ? value.leadTitle : undefined,
    contactName: typeof value.contactName === "string" ? value.contactName : undefined,
    scheduledFor: value.scheduledFor,
    note: typeof value.note === "string" ? value.note : undefined,
  };
}

function leadListPart(part: GatewayHistoryDataPart) {
  if (part.type !== "lead-list" || !part.id || !isRecord(part.data)) return undefined;
  return {
    type: "data-lead-list" as const,
    id: part.id,
    data: part.data as unknown as LeadListView,
  };
}

function propertyListPart(part: GatewayHistoryDataPart) {
  if (part.type !== "property-list" || !part.id || !isRecord(part.data)) {
    return undefined;
  }
  return {
    type: "data-property-list" as const,
    id: part.id,
    data: part.data as unknown as PropertyListView,
  };
}

function payloadString(event: GatewayEvent, key: string): string {
  const value = event.payload?.[key];
  return typeof value === "string" ? value : "";
}

function crmToolStatusLabel(endpoint: string): string {
  if (endpoint === LEAD_LIST_ENDPOINT) return "Fetching latest leads…";
  if (endpoint === PROPERTY_LIST_ENDPOINT) return "Fetching properties…";
  return "Fetching CRM data…";
}

function crmToolErrorLabel(message: string): string {
  if (/403|blocked|security service/i.test(message)) {
    return "CRM access was blocked. Check the CRM security or API access settings.";
  }
  if (/401|unauthori[sz]ed|authentication/i.test(message)) {
    return "CRM authentication failed. Check the configured CRM credentials.";
  }
  return "CRM request failed. Please try again.";
}

async function withTurnTimeout(turn: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      turn,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("gateway turn timed out")), TURN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  const session = await getAuthSession(request.headers);
  if (!session) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") ?? "";
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return Response.json({ error: "A valid session is required." }, { status: 400 });
  }
  const workspaceId = workspaceIdForUser(session.user.id);
  const gatewaySessionId = `${workspaceId}_${sessionId}`;

  const gateway = new GatewayRpcClient(
    process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787/ws",
    process.env.GATEWAY_WEB_TOKEN,
  );

  try {
    await gateway.connect(request.signal);
    const history = await gateway.request<{ messages: GatewayHistoryMessage[] }>(
      "session.history",
      { session_id: gatewaySessionId },
      request.signal,
    );

    return Response.json({
      messages: history.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message, index): CrmChatMessage => {
          const dataParts = (message.data_parts ?? [])
            .map((part) => leadListPart(part) ?? propertyListPart(part))
            .filter((part): part is NonNullable<typeof part> => Boolean(part));
          return {
            id: message.platform_message_id || `${sessionId}-${index}`,
            role: message.role,
            parts: [
              { type: "text" as const, text: message.content },
              ...dataParts,
            ],
          };
        }),
    });
  } catch {
    return Response.json({ messages: [] });
  } finally {
    gateway.close();
  }
}

export async function POST(request: Request) {
  const session = await getAuthSession(request.headers);
  if (!session) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = (await request.json()) as ChatRequestBody;
  const latestMessage = body.messages?.at(-1);
  const text = latestMessage?.role === "user" ? getMessageText(latestMessage).trim() : "";
  const sessionId = body.sessionId ?? body.id ?? "";
  const workspaceId = workspaceIdForUser(session.user.id);
  const action = body.action === undefined
    ? undefined
    : parseScheduleFollowUpAction(body.action);
  const requestId = latestMessage?.id && GATEWAY_REQUEST_ID_PATTERN.test(latestMessage.id)
    ? latestMessage.id
    : crypto.randomUUID();

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return Response.json({ error: "A valid session is required." }, { status: 400 });
  }
  const gatewaySessionId = `${workspaceId}_${sessionId}`;
  if (!text) {
    return Response.json({ error: "A message is required." }, { status: 400 });
  }
  if (body.action !== undefined && !action) {
    return Response.json({ error: "A valid lead action is required." }, { status: 400 });
  }

  const stream = createUIMessageStream<CrmChatMessage>({
    execute: async ({ writer }) => {
      const gateway = new GatewayRpcClient(
        process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787/ws",
        process.env.GATEWAY_WEB_TOKEN,
      );
      const partId = `response-${requestId}`;
      let textStarted = false;
      let textEnded = false;
      let acceptedTurnId = "";
      let submissionResolved = false;
      let replayPersistedResponse = false;
      let completeTurn: (() => void) | undefined;
      let failTurn: ((error: Error) => void) | undefined;
      let stopRequest: Promise<unknown> | undefined;
      let hasContent = false;
      const pendingEvents: GatewayEvent[] = [];
      const turnComplete = new Promise<void>((resolve, reject) => {
        completeTurn = resolve;
        failTurn = reject;
      });

      const startText = () => {
        if (textStarted) return;
        textStarted = true;
        writer.write({ type: "text-start", id: partId });
      };
      const endText = () => {
        if (!textStarted || textEnded) return;
        textEnded = true;
        writer.write({ type: "text-end", id: partId });
      };

      const handleGatewayEvent = (event: GatewayEvent) => {
        if (event.session_id !== gatewaySessionId) return;
        if (acceptedTurnId && event.turn_id && event.turn_id !== acceptedTurnId) return;

        if (event.type === "tool.start" && !replayPersistedResponse) {
          const runId = payloadString(event, "run_id");
          const toolName = payloadString(event, "tool_name");
          if (!runId || toolName !== CRM_TOOL_NAME) return;
          writer.write({
            type: "data-tool-status",
            id: runId,
            data: {
              status: "running",
              label: crmToolStatusLabel(payloadString(event, "endpoint")),
            } satisfies CrmToolStatusView,
          });
        } else if (event.type === "message.delta" && !replayPersistedResponse) {
          const delta = payloadString(event, "delta");
          if (!delta) return;
          startText();
          hasContent = true;
          writer.write({ type: "text-delta", id: partId, delta });
        } else if (
          event.type === "lead.list.available" &&
          !replayPersistedResponse
        ) {
          const data = event.payload?.data;
          const id = payloadString(event, "id");
          const runId = payloadString(event, "run_id");
          if (!id || !isRecord(data)) return;
          if (runId) {
            writer.write({
              type: "data-tool-status",
              id: runId,
              data: {
                status: "complete",
                label: "",
              } satisfies CrmToolStatusView,
            });
          }
          hasContent = true;
          writer.write({
            type: "data-lead-list",
            id,
            data: data as unknown as LeadListView,
          });
        } else if (
          event.type === "property.list.available" &&
          !replayPersistedResponse
        ) {
          const data = event.payload?.data;
          const id = payloadString(event, "id");
          const runId = payloadString(event, "run_id");
          if (!id || !isRecord(data)) return;
          if (runId) {
            writer.write({
              type: "data-tool-status",
              id: runId,
              data: {
                status: "complete",
                label: "",
              } satisfies CrmToolStatusView,
            });
          }
          hasContent = true;
          writer.write({
            type: "data-property-list",
            id,
            data: data as unknown as PropertyListView,
          });
        } else if (event.type === "tool.complete" && !replayPersistedResponse) {
          const runId = payloadString(event, "run_id");
          const toolName = payloadString(event, "tool_name");
          if (!runId || toolName !== CRM_TOOL_NAME) return;
          writer.write({
            type: "data-tool-status",
            id: runId,
            data: {
              status: "complete",
              label: "",
            } satisfies CrmToolStatusView,
          });
        } else if (event.type === "tool.error" && !replayPersistedResponse) {
          const runId = payloadString(event, "run_id");
          const toolName = payloadString(event, "tool_name");
          if (!runId || toolName !== CRM_TOOL_NAME) return;
          hasContent = true;
          writer.write({
            type: "data-tool-status",
            id: runId,
            data: {
              status: "error",
              label: crmToolErrorLabel(payloadString(event, "message")),
            } satisfies CrmToolStatusView,
          });
        } else if (
          event.type === "attachment.available" &&
          !replayPersistedResponse
        ) {
          const fileName = payloadString(event, "file_name") || "document";
          startText();
          hasContent = true;
          writer.write({
            type: "text-delta",
            id: partId,
            delta: `\n\nFile ready: ${fileName}`,
          });
        } else if (event.type === "turn.error") {
          failTurn?.(new Error(payloadString(event, "message") || "gateway turn failed"));
        } else if (event.type === "turn.complete") {
          completeTurn?.();
        }
      };

      const removeEventHandler = gateway.onEvent((event) => {
        if (!submissionResolved) {
          if (event.session_id === gatewaySessionId) pendingEvents.push(event);
          return;
        }
        handleGatewayEvent(event);
      });

      const onAbort = () => {
        stopRequest = gateway
          .request("prompt.stop", { session_id: gatewaySessionId })
          .catch(() => undefined);
        failTurn?.(new DOMException("Aborted", "AbortError"));
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      try {
        await gateway.connect(request.signal);
        await gateway.request(
          "session.create",
          { session_id: gatewaySessionId },
          request.signal,
        );
        const accepted = action
          ? await gateway.request<AcceptedTurn>(
              "lead.action.submit",
              {
                session_id: gatewaySessionId,
                action_id: action.actionId,
                type: action.type,
                lead_id: action.leadId,
                lead_title: action.leadTitle,
                contact_name: action.contactName,
                scheduled_for: action.scheduledFor,
                note: action.note,
                display_text: text,
              },
              request.signal,
            )
          : await gateway.request<AcceptedTurn>(
              "prompt.submit",
              {
                session_id: gatewaySessionId,
                request_id: requestId,
                text,
                compact_crm_results: true,
              },
              request.signal,
            );
        acceptedTurnId = accepted.turn_id;
        replayPersistedResponse = !action && accepted.duplicate === true;
        submissionResolved = true;
        for (const event of pendingEvents) handleGatewayEvent(event);
        pendingEvents.length = 0;

        if (replayPersistedResponse) {
          if (accepted.status === "error") {
            throw new Error("the original gateway turn failed");
          }
          if (accepted.status !== "complete") {
            await withTurnTimeout(turnComplete);
          }

          const history = await gateway.request<{
            messages: GatewayHistoryMessage[];
          }>(
            "session.history",
            { session_id: gatewaySessionId },
            request.signal,
          );
          const persisted = history.messages.findLast(
            (message) =>
              message.role === "assistant" &&
              message.platform_message_id === `assistant:${acceptedTurnId}`,
          );
          if (!persisted) {
            throw new Error("the completed gateway response was not persisted");
          }

          if (persisted.content) {
            startText();
            hasContent = true;
            writer.write({
              type: "text-delta",
              id: partId,
              delta: persisted.content,
            });
          }
          for (const dataPart of persisted.data_parts ?? []) {
            const part = leadListPart(dataPart) ?? propertyListPart(dataPart);
            if (!part) continue;
            hasContent = true;
            writer.write(part);
          }
        } else {
          await withTurnTimeout(turnComplete);
        }

        if (!hasContent) throw new Error("The agent returned an empty response.");
        endText();
      } finally {
        await stopRequest;
        request.signal.removeEventListener("abort", onAbort);
        removeEventHandler();
        gateway.close();
      }
    },
    onError: (error) => {
      console.error("CRM gateway chat request failed", error);
      return "The assistant could not complete that request.";
    },
  });

  return createUIMessageStreamResponse({ stream });
}
