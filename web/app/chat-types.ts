import type { UIMessage } from "ai";
import type {
  LeadListView,
  LeadView,
} from "../../src/gateway/crm-ui-types";

export type { LeadListView, LeadView };

export interface CrmToolStatusView {
  status: "running" | "complete" | "error";
  label: string;
}

export type CrmChatDataParts = {
  "lead-list": LeadListView;
  "tool-status": CrmToolStatusView;
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
