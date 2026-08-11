import type { UIMessage } from "ai";
import type {
  LeadListView,
  LeadView,
} from "../../src/gateway/crm-ui-types";

export type { LeadListView, LeadView };

export type CrmChatDataParts = {
  "lead-list": LeadListView;
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
