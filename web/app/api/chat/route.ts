import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { GatewayRpcClient, type GatewayEvent } from "./gateway-client";
import type {
  AttachmentView,
  CrmChatMessage,
  LeadListView,
  PropertyListView,
  ScheduleFollowUpAction,
} from "../../chat-types";
import { getAuthSession, workspaceIdForUser } from "../../../lib/auth-session";
import { isEmailDraftView } from "../../email-draft-data";
import {
  completedWorkingStatusPart,
  persistedAssistantMessageForTurn,
  payloadString,
  selectRelevantDataParts,
  temporaryStatusPartForEvent,
  workingStatusPart,
  type GatewayHistoryDataPart,
  type GatewayHistoryMessage,
} from "./turn-presentation";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_MESSAGE_LENGTH = 8_000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const TURN_TIMEOUT_MS = 240_000;
const GATEWAY_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

interface ChatRequestBody {
  id?: string;
  sessionId?: string;
  messages?: CrmChatMessage[];
  action?: unknown;
  attachmentIds?: string[];
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

function attachmentPart(part: GatewayHistoryDataPart) {
  if (part.type !== "attachment" || !part.id || !isRecord(part.data)) {
    return undefined;
  }
  const fileName = typeof part.data.fileName === "string" ? part.data.fileName : "";
  if (!fileName) return undefined;
  const downloadName =
    typeof part.data.downloadName === "string"
      ? part.data.downloadName
      : fileName.replace(/-[a-f0-9]{8}(?=\.[a-z0-9]+$)/i, "");
  return {
    type: "data-attachment" as const,
    id: part.id,
    data: {
      fileName,
      downloadName,
      mimeType: typeof part.data.mimeType === "string" ? part.data.mimeType : undefined,
    } satisfies AttachmentView,
  };
}

function emailDraftPart(part: GatewayHistoryDataPart) {
  if (part.type !== "email-draft" || !part.id || !isEmailDraftView(part.data)) return undefined;
  return { type: "data-email-draft" as const, id: part.id, data: part.data };
}

function historyDataParts(parts: GatewayHistoryDataPart[] | undefined, content: string) {
  return selectRelevantDataParts(parts, content)
    .map((part) => leadListPart(part) ?? propertyListPart(part) ?? emailDraftPart(part))
    .filter((part): part is NonNullable<typeof part> => Boolean(part));
}

function attachmentMarkdown(
  parts: GatewayHistoryDataPart[] | undefined,
  extraNames: string[] = [],
): string {
  const files = new Map<string, string>();
  for (const part of parts ?? []) {
    const attachment = attachmentPart(part);
    if (attachment) {
      files.set(attachment.data.fileName, attachment.data.downloadName ?? attachment.data.fileName);
    }
  }
  for (const name of extraNames) {
    if (!files.has(name)) {
      files.set(name, name.replace(/-[a-f0-9]{8}(?=\.[a-z0-9]+$)/i, ""));
    }
  }
  return [...files]
    .map(
      ([fileName, downloadName]) =>
        `[Download ${downloadName}](/api/files?name=${encodeURIComponent(fileName)})`,
    )
    .join("\n\n");
}


class GatewayTurnTimeoutError extends Error {}
class GatewayTurnAbortedError extends Error {}

async function withTurnTimeout(turn: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      turn,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new GatewayTurnTimeoutError("gateway turn timed out")),
          TURN_TIMEOUT_MS,
        );
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
        .map((message, index): CrmChatMessage => ({
          id: message.platform_message_id || `${sessionId}-${index}`,
          role: message.role,
          parts: [
            { type: "text" as const, text: [message.content, attachmentMarkdown(message.data_parts)].filter(Boolean).join("\n\n") },
            ...historyDataParts(message.data_parts, message.content),
            ...(message.data_parts ?? []).flatMap((part) => part.type === "source-document" && part.id && /^[a-f0-9-]{36}$/.test(part.id)
              ? [{ type: "data-source-document" as const, id: part.id, data: { attachmentId: part.id } }]
              : []),
          ],
        })),
    });
  } catch {
    return Response.json({ error: "Conversation history is temporarily unavailable." }, { status: 503 });
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
      const workingPartId = `working-${requestId}`;
      let textStarted = false;
      let textEnded = false;
      let acceptedTurnId = "";
      let submissionResolved = false;
      let completeTurn: (() => void) | undefined;
      let failTurn: ((error: Error) => void) | undefined;
      let stopRequest: Promise<unknown> | undefined;
      let hasContent = false;
      const pendingEvents: GatewayEvent[] = [];
      const attachmentNames: string[] = [];
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

      writer.write(workingStatusPart(workingPartId));

      const handleGatewayEvent = (event: GatewayEvent) => {
        if (event.session_id !== gatewaySessionId) return;
        if (acceptedTurnId && event.turn_id && event.turn_id !== acceptedTurnId) return;

        const temporaryStatus = temporaryStatusPartForEvent(event, workingPartId);
        if (temporaryStatus) writer.write(temporaryStatus);

        if (event.type === "attachment.available") {
          const fileName = payloadString(event, "file_name");
          if (fileName && !attachmentNames.includes(fileName)) {
            attachmentNames.push(fileName);
          }
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
        if (submissionResolved) {
          failTurn?.(new GatewayTurnAbortedError("gateway turn aborted"));
        }
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
                attachment_ids: body.attachmentIds,
              },
              request.signal,
            );
        acceptedTurnId = accepted.turn_id;
        submissionResolved = true;
        for (const event of pendingEvents) handleGatewayEvent(event);
        pendingEvents.length = 0;

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
        const persisted = persistedAssistantMessageForTurn(
          history.messages,
          acceptedTurnId,
        );
        if (!persisted) {
          throw new Error("the completed gateway response was not persisted");
        }

        writer.write(completedWorkingStatusPart(workingPartId));
        const finalText = [
          persisted.content,
          attachmentMarkdown(persisted.data_parts, attachmentNames),
        ].filter(Boolean).join("\n\n");
        if (finalText) {
          startText();
          hasContent = true;
          writer.write({ type: "text-delta", id: partId, delta: finalText });
        }
        for (const dataPart of historyDataParts(
          persisted.data_parts,
          persisted.content,
        )) {
          hasContent = true;
          writer.write(dataPart);
        }

        if (!hasContent) throw new Error("The agent returned an empty response.");
        endText();
      } catch (error) {
        if (request.signal.aborted || error instanceof GatewayTurnAbortedError) {
          return;
        }
        if (error instanceof GatewayTurnTimeoutError) {
          stopRequest = gateway
            .request("prompt.stop", { session_id: gatewaySessionId })
            .catch(() => undefined);
        }
        throw error;
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
