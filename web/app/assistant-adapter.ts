import type {
  AttachmentAdapter,
  CompleteAttachment,
  ThreadMessageLike,
} from "@assistant-ui/react";
import { DefaultChatTransport, readUIMessageStream } from "ai";
import type { CrmChatMessage } from "./chat-types";
import { emailDraftMailto, isEmailDraftView } from "./email-draft-data";

export interface ChatDocument {
  id: string;
  fileName: string;
  mimeType: string;
  generated: boolean;
  readable: boolean;
  warnings: string[];
}

export async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || `Request failed (${response.status}).`);
  return body as T;
}

export function documentAttachment(document: ChatDocument): CompleteAttachment {
  const url = `/api/attachments?id=${encodeURIComponent(document.id)}`;
  const isImage = document.mimeType.startsWith("image/");
  return {
    id: document.id,
    name: document.fileName,
    contentType: document.mimeType,
    type: isImage ? "image" : "document",
    status: { type: "complete" },
    content: isImage
      ? [{ type: "image", image: url, filename: document.fileName }]
      : [
          {
            type: "file",
            data: url,
            mimeType: document.mimeType,
            filename: document.fileName,
          },
        ],
  };
}

export function attachmentAdapter(
  sessionId: string,
  getSignal: () => AbortSignal,
  notify: (message: string) => void,
): AttachmentAdapter {
  return {
    accept: ".pdf,.docx,.png,.jpg,.jpeg,.webp",
    async add({ file }) {
      if (!/\.(pdf|docx|png|jpe?g|webp)$/i.test(file.name))
        throw new Error("Choose a PDF, DOCX, JPEG, PNG or WebP file.");
      if (!file.size || file.size > 15 * 1024 * 1024)
        throw new Error("Choose a non-empty document up to 15 MB.");
      const form = new FormData();
      form.set("file", file);
      form.set("sessionId", sessionId);
      const { attachment } = await requestJson<{ attachment: ChatDocument }>(
        "/api/attachments",
        { method: "POST", body: form, signal: getSignal() },
      );
      if (attachment.warnings.length || !attachment.readable) {
        notify(
          `${attachment.fileName}: ${attachment.warnings.join(" ") || "This document could not be read."}`,
        );
      }
      return {
        ...documentAttachment(attachment),
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
    },
    async send(attachment) {
      return {
        ...attachment,
        status: { type: "complete" },
        content: attachment.content ?? [],
      };
    },
    async remove(attachment) {
      // Failed uploads have runtime-generated IDs and no stored object.
      if (!/^[a-f0-9-]{36}$/.test(attachment.id)) return;
      try {
        await requestJson(
          `/api/attachments?id=${encodeURIComponent(attachment.id)}`,
          { method: "DELETE", signal: getSignal() },
        );
      } catch (error) {
        notify(
          error instanceof Error
            ? error.message
            : "The document could not be removed.",
        );
        throw error;
      }
    },
  };
}

const escapeMarkdown = (value: string | undefined) =>
  (value || "—")
    .replace(/[\\`*_{}[\]()#+.!|<>~-]/g, "\\$&")
    .replace(/\r?\n/g, " ");

export function toAssistantMessage(
  message: CrmChatMessage,
  documents: readonly ChatDocument[] = [],
): ThreadMessageLike {
  const content: Exclude<ThreadMessageLike["content"], string>[number][] = [];
  const attachments: CompleteAttachment[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        if (part.text) content.push({ type: "text", text: part.text });
        break;
      case "data-source-document": {
        const document = documents.find(
          (item) => item.id === part.data.attachmentId,
        );
        if (document) attachments.push(documentAttachment(document));
        else
          content.push({
            type: "text",
            text: "Attachment no longer available.",
          });
        break;
      }
      case "data-tool-status":
        content.push({
          type: "tool-call",
          toolCallId: part.id || "gateway-status",
          toolName: part.data.label,
          args: {},
          result: part.data.status === "running" ? undefined : part.data.label,
          isError: part.data.status === "error",
        });
        break;
      case "data-lead-list":
        content.push({
          type: "data",
          name: "lead-list",
          data: part.data,
        });
        break;
      case "data-property-list":
        content.push({
          type: "data",
          name: "property-list",
          data: part.data,
        });
        break;
      case "data-email-draft": {
        const draft = part.data;
        if (!isEmailDraftView(draft)) break;
        content.push({
          type: "text",
          text: [
            `**Email draft · revision ${draft.revision}**`,
            `To: ${escapeMarkdown(draft.recipient)}\n\nSubject: ${escapeMarkdown(draft.subject)}`,
            draft.body
              .split(/\r?\n/)
              .map((line) => `> ${escapeMarkdown(line || " ")}`)
              .join("\n"),
            `[Open in mail app](${emailDraftMailto(draft)}) · [Download draft](/api/attachments?id=${encodeURIComponent(draft.downloadAttachmentId)})`,
            ...draft.attachmentIds.map(
              (id, index) =>
                `[Attachment ${index + 1}](/api/attachments?id=${encodeURIComponent(id)})`,
            ),
          ].join("\n\n"),
        });
        break;
      }
    }
  }
  return { id: message.id, role: message.role, content, attachments };
}

export async function* streamReply(
  sessionId: string,
  message: CrmChatMessage,
  attachmentIds: string[],
  signal: AbortSignal,
) {
  if (attachmentIds.length > 12)
    throw new Error("Attach up to 12 documents per message.");
  const stream = await new DefaultChatTransport<CrmChatMessage>({
    api: "/api/chat",
  }).sendMessages({
    trigger: "submit-message",
    chatId: sessionId,
    messageId: message.id,
    messages: [message],
    abortSignal: signal,
    body: { sessionId, attachmentIds },
  });
  for await (const reply of readUIMessageStream<CrmChatMessage>({
    stream,
    terminateOnError: true,
  })) {
    yield toAssistantMessage(reply);
  }
}
