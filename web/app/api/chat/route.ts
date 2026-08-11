import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { GatewayRpcClient, type GatewayEvent } from "./gateway-client";
import type {
  CrmChatMessage,
  LeadListView,
  ScheduleFollowUpAction,
} from "../../chat-types";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_MESSAGE_LENGTH = 8_000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TURN_TIMEOUT_MS = 120_000;

interface ChatRequestBody {
  id?: string;
  sessionId?: string;
  workspaceId?: string;
  messages?: CrmChatMessage[];
  action?: unknown;
}

interface GatewayHistoryDataPart {
  type?: string;
  id?: string;
  data?: unknown;
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

function payloadString(event: GatewayEvent, key: string): string {
  const value = event.payload?.[key];
  return typeof value === "string" ? value : "";
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
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const workspaceId = url.searchParams.get("workspaceId") ?? "";
  if (!SESSION_ID_PATTERN.test(sessionId) || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return Response.json({ error: "A valid session is required." }, { status: 400 });
  }
  const gatewaySessionId = `${workspaceId}_${sessionId}`;

  const gateway = new GatewayRpcClient(
    process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787/ws",
    process.env.GATEWAY_WEB_TOKEN,
  );

  try {
    await gateway.connect(request.signal);
    const history = await gateway.request<{
      messages: Array<{
        role: "user" | "assistant" | "system";
        content: string;
        data_parts?: GatewayHistoryDataPart[];
      }>;
    }>("session.history", { session_id: gatewaySessionId }, request.signal);

    return Response.json({
      messages: history.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message, index): CrmChatMessage => {
          const dataParts = (message.data_parts ?? [])
            .map(leadListPart)
            .filter((part): part is NonNullable<typeof part> => Boolean(part));
          return {
            id: `${sessionId}-${index}`,
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
  const body = (await request.json()) as ChatRequestBody;
  const latestMessage = body.messages?.at(-1);
  const text = latestMessage?.role === "user" ? getMessageText(latestMessage).trim() : "";
  const sessionId = body.sessionId ?? body.id ?? "";
  const workspaceId = body.workspaceId ?? "";
  const action = body.action === undefined
    ? undefined
    : parseScheduleFollowUpAction(body.action);

  if (!SESSION_ID_PATTERN.test(sessionId) || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
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
      const partId = crypto.randomUUID();
      let textStarted = false;
      let textEnded = false;
      let acceptedTurnId = "";
      let completeTurn: (() => void) | undefined;
      let failTurn: ((error: Error) => void) | undefined;
      let stopRequest: Promise<unknown> | undefined;
      let hasContent = false;
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

      const removeEventHandler = gateway.onEvent((event) => {
        if (event.session_id !== gatewaySessionId) return;
        if (acceptedTurnId && event.turn_id && event.turn_id !== acceptedTurnId) return;

        if (event.type === "message.delta") {
          const delta = payloadString(event, "delta");
          if (!delta) return;
          startText();
          hasContent = true;
          writer.write({ type: "text-delta", id: partId, delta });
        } else if (event.type === "lead.list.available") {
          const data = event.payload?.data;
          const id = payloadString(event, "id");
          if (!id || !isRecord(data)) return;
          hasContent = true;
          writer.write({
            type: "data-lead-list",
            id,
            data: data as unknown as LeadListView,
          });
        } else if (event.type === "attachment.available") {
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
          ? await gateway.request<{ turn_id: string }>(
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
          : await gateway.request<{ turn_id: string }>(
              "prompt.submit",
              { session_id: gatewaySessionId, text },
              request.signal,
            );
        acceptedTurnId = accepted.turn_id;

        await withTurnTimeout(turnComplete);

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
