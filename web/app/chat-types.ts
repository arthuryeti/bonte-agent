import type { UIMessage } from "ai";
import type {
  LeadListView,
  LeadView,
  PropertyListView,
  PropertyView,
} from "../../src/gateway/crm-ui-types";

export type { LeadListView, LeadView, PropertyListView, PropertyView };

export interface CrmToolStatusView {
  status: "running" | "complete" | "error";
  label: string;
}

export type CrmChatDataParts = {
  "lead-list": LeadListView;
  "property-list": PropertyListView;
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
