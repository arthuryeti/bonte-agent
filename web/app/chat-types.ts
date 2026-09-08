import type { UIMessage } from "ai";
import type {
  EmailDraftView,
  LeadListView,
  LeadView,
  PropertyListView,
  PropertyView,
} from "../../src/gateway/crm-ui-types";

export type { EmailDraftView, LeadListView, LeadView, PropertyListView, PropertyView };

export interface CrmToolStatusView {
  status: "running" | "complete" | "error";
  label: string;
}

export interface AttachmentView {
  fileName: string;
  downloadName?: string;
  mimeType?: string;
}

export type CrmChatDataParts = {
  "lead-list": LeadListView;
  "property-list": PropertyListView;
  "tool-status": CrmToolStatusView;
  "email-draft": EmailDraftView;
  attachment: AttachmentView;
  "source-document": { attachmentId: string };
};

export type CrmChatMessage = UIMessage<unknown, CrmChatDataParts>;

export interface ScheduleFollowUpAction {
  actionId: string;
  type: "schedule_follow_up";
  leadId: string;
  leadTitle?: string;
  contactName?: string;
  scheduledFor: string;
  note?: string;
}
