import type { EmailDraftView } from "./chat-types";

const attachmentIdPattern = /^[a-f0-9-]{36}$/;
const headerControlPattern = /[\x00-\x1f\x7f]/;

export function isEmailDraftView(value: unknown): value is EmailDraftView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return typeof draft.id === "string" && draft.id.length > 0
    && typeof draft.revision === "number" && Number.isSafeInteger(draft.revision) && draft.revision > 0
    && (draft.recipient === undefined || (typeof draft.recipient === "string" && !headerControlPattern.test(draft.recipient)))
    && typeof draft.subject === "string" && !headerControlPattern.test(draft.subject)
    && typeof draft.body === "string"
    && typeof draft.downloadAttachmentId === "string" && attachmentIdPattern.test(draft.downloadAttachmentId)
    && Array.isArray(draft.attachmentIds) && draft.attachmentIds.every((id) => typeof id === "string" && attachmentIdPattern.test(id));
}

export function emailDraftMailto(draft: EmailDraftView): string {
  const encode = (value: string) => encodeURIComponent(value.toWellFormed());
  const recipients = (draft.recipient || "").split(",").map((recipient) => encode(recipient.trim()).replace(/%40/g, "@")).join(",");
  return `mailto:${recipients}?subject=${encode(draft.subject)}&body=${encode(draft.body.replace(/\r\n|\r|\n/g, "\r\n"))}`;
}
