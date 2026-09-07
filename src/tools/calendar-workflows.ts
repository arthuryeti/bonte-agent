import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { CalendarWorkflowError, CalendarWorkflowService, type ViewingSlot } from "../workflows/calendar.js";
import { getWorkflowContext } from "../workflows/context.js";
import { getWorkflowStore } from "../workflows/store.js";
import { resolveExactProperty } from "../workflows/crm-properties.js";

const service = () => new CalendarWorkflowService(getWorkflowStore());
async function result(action: () => Promise<unknown> | unknown) {
  try {
    const output = await action() as { viewing?: { state: string; lastOperation?: { result: string } }; complete?: boolean };
    const success = output.complete !== false && output.viewing?.state !== "uncertain" && output.viewing?.lastOperation?.result !== "rejected";
    return JSON.stringify({ success, ...output });
  }
  catch (error) { return JSON.stringify({ success: false, code: error instanceof CalendarWorkflowError ? error.code : "calendar_workflow_failed", message: error instanceof Error ? error.message : "Calendar workflow failed." }); }
}
const id = z.string().min(1).max(200);
const timeFields = {
  start: z.string().describe("RFC3339 local date/time with explicit UTC offset and seconds, e.g. 2026-09-15T10:00:00+01:00."),
  end: z.string().describe("RFC3339 end with explicit UTC offset and seconds."),
  timeZone: z.string().describe("Explicit IANA timezone agreed with the user, e.g. Europe/Lisbon. Offset must agree with timezone including DST."),
  travelBufferMinutes: z.number().int().min(0).max(180).default(0).describe("Travel time reserved after this viewing before another appointment."),
};
const requestId = id.describe("Stable ID for this action; reuse it on retry. Prefer the current user message ID plus an action suffix.");

export const calendarStatusTool = tool(async () => result(() => service().setup(getWorkflowContext())), {
  name: "calendar_workflow_status", description: "Check deployed team Google Calendar setup, authorized scope, and available calendar IDs without accessing secrets. Use before the first viewing booking. Missing setup means bookings are unavailable, but proposals can still be saved.", schema: z.object({}),
});
export const proposeViewingsTool = tool(async input => result(async () => {
  const scope = getWorkflowContext();
  const viewings: ViewingSlot[] = [];
  for (const slot of input.viewings) {
    const verified = await resolveExactProperty({ propertyId: slot.propertyId, reference: slot.reference });
    viewings.push({ propertyId: verified.propertyId, reference: verified.reference,
      title: slot.title ?? verified.reference, location: slot.meetingLocation,
      start: slot.start, end: slot.end, timeZone: slot.timeZone, notes: slot.notes, travelBufferMinutes: slot.travelBufferMinutes });
  }
  return await service().propose(scope, { ...input, viewings });
}), {
  name: "propose_viewings",
  description: "Save one or consecutive viewing proposals in Bonte after resolving exact CRM properties. Requires participant emails when known, actual meeting locations, dates and explicit timezone. Consecutive slots must include travel buffers. This never creates Google events or invites. Missing owner contact information must be requested, not invented.",
  schema: z.object({ requestId, calendarId: z.string().min(1).max(300), availabilityCalendarIds: z.array(z.string().min(1).max(300)).max(49).optional(), attendees: z.array(z.object({ email: z.string().email(), name: z.string().max(200).optional(), optional: z.boolean().optional() })).max(50).optional(), viewings: z.array(z.object({ propertyId: z.number().int().positive().optional(), reference: z.string().max(100).optional(), title: z.string().min(1).max(300).optional(), meetingLocation: z.string().min(1).max(1000).describe("Verified property address or an explicit meeting point supplied by the user."), notes: z.string().max(5000).optional(), ...timeFields })).min(1).max(10) }),
});
export const viewingAvailabilityTool = tool(async ({ viewingId }) => result(() => service().availability(getWorkflowContext(), viewingId)), {
  name: "check_viewing_availability", description: "Check a saved proposed/booked viewing against configured accessible Google calendars, including its travel buffer. Unknown availability blocks booking. A free slot is not a reservation and does not establish client/owner acceptance.", schema: z.object({ viewingId: id }),
});
export const bookViewingsTool = tool(async input => result(async () => {
  const workflow = service(); const scope = getWorkflowContext(); const viewings = [];
  // Deliberately sequential: each verified booking is durable before attempting the next.
  for (const viewingId of input.viewingIds) {
    try {
      const viewing = await workflow.mutate(scope, { id: viewingId, requestId: input.requestId, action: "book", explicitlyRequested: input.explicitlyRequested, sendInvitations: input.sendInvitations });
      viewings.push(viewing);
      if (viewing.state !== "booked") return { viewings, complete: false, remainingViewingIds: input.viewingIds.slice(viewings.length), message: "Booking stopped. Earlier completed bookings remain on Google Calendar; inspect the pending result before taking another action." };
    } catch (error) {
      return { viewings, complete: false, failedViewingId: viewingId, remainingViewingIds: input.viewingIds.slice(viewings.length), issue: error instanceof Error ? error.message : "Booking failed", message: "Earlier completed bookings remain on Google Calendar. No automatic cancellation was sent." };
    }
  }
  return { viewings, complete: true, message: "Events were verified in Google Calendar. Participant acceptance is reported separately; booked does not mean accepted." };
}), {
  name: "book_viewings", description: "Execute an explicitly requested booking of saved viewing IDs in order, checking availability immediately before each write. Set sendInvitations only when the user requests booking with/inviting those named participants. Existing requests are reconciled without duplicate writes. Multi-viewing booking can partially succeed; report each result precisely.",
  schema: z.object({ requestId, viewingIds: z.array(id).min(1).max(10), explicitlyRequested: z.boolean().describe("True only if the user asked to book these viewings, rather than suggesting/checking possible slots."), sendInvitations: z.boolean().default(false).describe("True only when booking with the supplied attendees/invitations was requested. False creates a team-calendar event with no attendees.") }),
});
export const rescheduleViewingTool = tool(async input => result(async () => {
  const workflow = service(); const scope = getWorkflowContext();
  const viewing = await workflow.get(scope, input.viewingId);
  return { viewing: await workflow.mutate(scope, { id: viewing.id, requestId: input.requestId, action: "reschedule", explicitlyRequested: input.explicitlyRequested, replacement: { propertyId: viewing.propertyId, reference: viewing.reference, title: viewing.title, location: viewing.location, notes: viewing.notes, ...input.time } }) };
}), {
  name: "reschedule_viewing", description: "Move an existing booked viewing after an explicit user request. Checks availability while excluding only its own event, then updates the same Google event using its current version. Previously invited attendees receive the schedule update; their acceptance is read back separately. Never creates a replacement event after a timeout.",
  schema: z.object({ viewingId: id, requestId, explicitlyRequested: z.boolean(), time: z.object(timeFields) }),
});
export const cancelViewingTool = tool(async input => result(async () => ({ viewing: await service().mutate(getWorkflowContext(), { id: input.viewingId, requestId: input.requestId, action: "cancel", explicitlyRequested: input.explicitlyRequested }) })), {
  name: "cancel_viewing", description: "Cancel a saved proposal or Google Calendar viewing only when explicitly requested. Verifies event ownership, cancels using the current provider version, and sends cancellation updates to attendees who were invited. Timeout outcomes are reconciled before any further write.", schema: z.object({ viewingId: id, requestId, explicitlyRequested: z.boolean() }),
});
export const getViewingsTool = tool(async input => result(async () => {
  const workflow = service(); const scope = getWorkflowContext();
  if (input.viewingId) return { viewing: await workflow.reconcile(scope, input.viewingId) };
  return { viewings: await workflow.list(scope, input.limit), coverage: "Most recently updated saved viewings; provide a viewing ID to refresh provider status and participant responses." };
}), {
  name: "get_viewings", description: "List this workspace's durable viewing proposals/bookings, or reconcile one saved viewing with Google Calendar. Use after uncertainty, a retry, or to check participant acceptance. Reconciliation is read-only at Google and does not resend invites.", schema: z.object({ viewingId: id.optional(), limit: z.number().int().min(1).max(100).default(30) }),
});

export const calendarWorkflowTools = [calendarStatusTool, proposeViewingsTool, viewingAvailabilityTool, bookViewingsTool, rescheduleViewingTool, cancelViewingTool, getViewingsTool];
