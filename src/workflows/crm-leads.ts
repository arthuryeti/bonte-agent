import * as z from "zod";
import { callCrmApi, CrmApiError } from "../client/crm-client.js";
import { crmLanguages } from "./crm-enums.js";
import { record, records, string, number, normalizeText, normalizeEmail, normalizePhone, crmWarnings, type CrmRecord, type DataCoverage } from "./crm-common.js";

export { normalizeEmail, normalizePhone } from "./crm-common.js";
export type LeadRecord = CrmRecord;
export interface LeadDataset { leads: LeadRecord[]; coverage: DataCoverage }
const dateInput = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)), "Use an ISO date or timestamp.");
export const leadQuerySchema = z.object({
  language: z.enum(crmLanguages).optional(), category: z.enum(["Sales", "Listings"]).optional(), originId: z.number().int().positive().optional(),
  leadId: z.string().trim().min(1).optional(), name: z.string().trim().min(1).optional(), email: z.string().email().optional(), phone: z.string().min(5).optional(),
  broker: z.string().trim().min(1).optional(), brokerId: z.string().trim().min(1).optional(), origin: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(), outcome: z.string().trim().min(1).optional(),
  createdFrom: dateInput.optional(), createdTo: dateInput.optional(), searchText: z.string().trim().min(1).optional(),
}).strict();
export type LeadQuery = z.infer<typeof leadQuerySchema>;

function pick(source: CrmRecord, fields: string[]): CrmRecord {
  return Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
}

export function minimizeLead(raw: CrmRecord): LeadRecord {
  // Preserve operational descriptions/events; do not retain unrelated identity documents or marital/birth/tax details.
  return { ...pick(raw, ["Id", "Title", "CurrentStatus", "CreateDate", "LastUpdate", "Origin", "Description", "Outcome", "OutcomeDate", "SalePrice", "EventPriority", "EventType"]),
    Agents: records(raw.Agents).map((agent) => pick(agent, ["AgentID", "AgentName"])),
    Properties: records(raw.Properties).map((property) => pick(property, ["PropertyID", "Reference", "Address", "Title", "Name", "Price", "LastUpdate"])),
    Customer: pick(record(raw.Customer), ["Name", "EmailAddress", "PhoneNumber", "Language"]),
    ...(Array.isArray(raw.Events) ? { Events: records(raw.Events).map((event) => ({
      ...pick(event, ["EventID", "EventType", "EventTypeID", "Title", "Location", "Description", "StartDate", "EndDate"]),
      Agents: records(event.Agents).map((agent) => pick(agent, ["AgentID", "AgentName"])),
    })) } : {}),
  };
}

/** Fetch the full available response before local filtering, limits or aggregations. */
export async function fetchAllLeads(input: LeadQuery = {}): Promise<LeadDataset> {
  const query = leadQuerySchema.parse(input);
  const response = await callCrmApi({ endpoint: "/api/Leads/List", method: "POST", body: {
    Language: query.language ?? "en", ...(query.category ? { Category: query.category } : {}), ...(query.originId ? { OriginId: query.originId } : {}),
  } });
  const data = record(response.data);
  if (!Array.isArray(data.Opportunities)) throw new CrmApiError("CRM response is missing Opportunities; this is not an empty lead list.", undefined, "contract");
  const raw = records(data.Opportunities);
  const seen = new Set<string>();
  let duplicates = 0;
  const leads = raw.map(minimizeLead).filter((lead) => {
    const id = string(lead.Id); if (!id) return true;
    if (seen.has(id)) { duplicates++; return false; } seen.add(id); return true;
  });
  return { leads, coverage: {
    source: "Casafari CRM Leads/List", fetchedAt: new Date().toISOString(), fetchedRecords: leads.length, complete: false,
    scope: `${query.category ?? "all returned categories"}${query.originId ? `; source ID ${query.originId}` : ""}; complete returned opportunity dataset, event-history completeness unknown`,
    warnings: [...crmWarnings(data), "The documented endpoint provides no pagination or independent total. Counts cover all returned opportunities, not a verified complete CRM directory.",
      ...(leads.some((lead) => !Array.isArray(lead.Events)) ? ["Some opportunities omit Events; missing history cannot prove a lead was unanswered."] : []),
      ...(duplicates ? [`Deduplicated ${duplicates} repeated opportunity IDs.`] : []),
      ...(!process.env.CRM_TIMEZONE && !process.env.CRM_DATE_TIMEZONE && leads.some((lead) => /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(String(lead.CreateDate))) ? ["CRM_TIMEZONE is not configured; offset-free timestamps cannot establish exact response durations or closing-date boundaries."] : []),
      ...(leads.some((lead) => !string(lead.Id)) ? ["Some opportunities lack IDs and cannot be deduplicated or acted on reliably."] : []),
    ],
  } };
}

const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();
function zonedParts(timestamp: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  let formatter = timezoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    timezoneFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(timestamp);
  const result = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return result as ReturnType<typeof zonedParts>;
}
function localToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number | undefined {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(target);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return undefined;
  let candidate = target;
  for (let iteration = 0; iteration < 4; iteration++) {
    const local = zonedParts(candidate, timeZone);
    const adjusted = candidate + target - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    if (candidate === adjusted) {
      // An offset-free local time during the autumn fold identifies two
      // instants. Do not silently choose one for a response-time metric.
      for (const delta of [-7_200_000, -3_600_000, -1_800_000, 1_800_000, 3_600_000, 7_200_000]) {
        const alternate = zonedParts(candidate + delta, timeZone);
        if (Date.UTC(alternate.year, alternate.month - 1, alternate.day, alternate.hour, alternate.minute) === target) return undefined;
      }
      return candidate;
    }
    candidate = adjusted;
  }
  return undefined; // Nonexistent local times must not be guessed across a DST jump.
}

/** Date-only values retain their calendar date. Offset-free timestamps need a configured tenant timezone. */
export function parseCrmDate(value: unknown, timeZone = process.env.CRM_TIMEZONE || process.env.CRM_DATE_TIMEZONE): number | undefined {
  const raw = string(value); if (!raw) return undefined;
  const datePart = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!datePart || new Date(Date.UTC(+datePart[1], +datePart[2] - 1, +datePart[3])).toISOString().slice(0, 10) !== raw.slice(0, 10)) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = Date.parse(`${raw}T00:00:00Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== raw) return undefined;
    if (!timeZone) return parsed;
    try { return localToUtc(+datePart[1], +datePart[2], +datePart[3], 0, 0, timeZone); } catch { return undefined; }
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = Date.parse(raw); return Number.isFinite(parsed) ? parsed : undefined;
  }
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(raw);
  if (!parts || !timeZone) return undefined;
  if (Number(parts[6] ?? 0) > 59) return undefined;
  try {
    const parsed = localToUtc(+parts[1], +parts[2], +parts[3], +parts[4], +parts[5], timeZone);
    return parsed === undefined ? undefined : parsed + Number(parts[6] ?? 0) * 1000 + Number(`0.${parts[7] ?? "0"}`) * 1000;
  } catch { return undefined; }
}

function bound(value: string | undefined, end = false): number | undefined {
  if (!value) return undefined;
  const parsed = parseCrmDate(value); if (parsed === undefined) throw new Error(`Date ${value} requires an explicit timezone or CRM_TIMEZONE configuration.`);
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const nextDate = new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const nextMidnight = parseCrmDate(nextDate); if (nextMidnight === undefined) throw new Error("Report boundary is ambiguous in the configured CRM timezone.");
    return nextMidnight - 1;
  }
  return parsed;
}

export function queryLeads(dataset: LeadDataset, input: LeadQuery = {}): LeadRecord[] {
  const query = leadQuerySchema.parse(input);
  const from = bound(query.createdFrom), to = bound(query.createdTo, true);
  if (from !== undefined && to !== undefined && from > to) throw new Error("createdFrom must precede createdTo.");
  return dataset.leads.filter((lead) => {
    const customer = record(lead.Customer);
    if (query.leadId && String(lead.Id) !== query.leadId) return false;
    if (query.name && !normalizeText(customer.Name).includes(normalizeText(query.name))) return false;
    if (query.email && normalizeEmail(customer.EmailAddress) !== normalizeEmail(query.email)) return false;
    if (query.phone && (!normalizePhone(query.phone) || normalizePhone(customer.PhoneNumber) !== normalizePhone(query.phone))) return false;
    if (query.brokerId && !records(lead.Agents).some((agent) => String(agent.AgentID) === query.brokerId)) return false;
    if (query.broker && !records(lead.Agents).some((agent) => normalizeText(agent.AgentName).includes(normalizeText(query.broker)))) return false;
    for (const [key, field] of [["origin", "Origin"], ["status", "CurrentStatus"], ["outcome", "Outcome"]] as const) {
      if (query[key] && normalizeText(lead[field]) !== normalizeText(query[key])) return false;
    }
    if (from !== undefined || to !== undefined) {
      const created = parseCrmDate(lead.CreateDate);
      if (created === undefined || (from !== undefined && created < from) || (to !== undefined && created > to)) return false;
    }
    if (query.searchText && !normalizeText([lead.Title, lead.Description, ...records(lead.Events).flatMap((event) => [event.Title, event.Description])].filter(Boolean).join(" ")).includes(normalizeText(query.searchText))) return false;
    return true;
  });
}

export function findLeadContacts(dataset: LeadDataset, query: { name?: string; email?: string; phone?: string }) {
  if (!query.name?.trim() && !query.email?.trim() && !query.phone?.trim()) throw new Error("Provide a name, email or phone for the contact check.");
  const matches = dataset.leads.flatMap((lead) => {
    const customer = record(lead.Customer); const matchedBy: string[] = [];
    if (query.email && normalizeEmail(customer.EmailAddress) === normalizeEmail(query.email)) matchedBy.push("email");
    if (query.phone && normalizePhone(query.phone) && normalizePhone(customer.PhoneNumber) === normalizePhone(query.phone)) matchedBy.push("phone");
    if (query.name && normalizeText(customer.Name).includes(normalizeText(query.name))) matchedBy.push("name");
    return matchedBy.length ? [{ leadId: string(lead.Id), customer, matchedBy, identityStrength: matchedBy.some((field) => field !== "name") ? "contact_identifier" : "name_only", properties: records(lead.Properties), title: string(lead.Title), agents: records(lead.Agents), description: string(lead.Description) }] : [];
  });
  return { matches, coverage: dataset.coverage, scope: "Customers appearing in returned lead opportunities; not a general customer, developer or owner directory.",
    conclusion: matches.length ? "Potential existing contacts found; distinguish a new enquiry from an existing opportunity." : "No match in the searched lead history. This does not establish that the contact is absent from the CRM." };
}

export const businessHoursSchema = z.object({ timeZone: z.string(), weekdays: z.array(z.number().int().min(0).max(6)).min(1), startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(1).max(24) })
  .refine((value) => value.startHour < value.endHour, "Business hours must end after they start.");
export interface AuditPolicy {
  now?: string; firstResponseHours?: number; inactivityHours?: number;
  businessHours?: z.infer<typeof businessHoursSchema>;
  completedContactEventTypeIds?: number[]; completedContactEventTypes?: string[]; closedOutcomes?: string[];
  eventHistoryComplete?: boolean;
}
export function configuredAuditPolicy(): AuditPolicy {
  const parseArray = (name: string): unknown[] => { try { return JSON.parse(process.env[name] || "[]"); } catch { throw new Error(`${name} must contain a JSON array.`); } };
  return {
    firstResponseHours: z.coerce.number().positive().parse(process.env.CRM_FIRST_RESPONSE_HOURS || 24),
    inactivityHours: z.coerce.number().positive().parse(process.env.CRM_INACTIVITY_HOURS || 168),
    completedContactEventTypeIds: z.array(z.number().int()).parse(parseArray("CRM_COMPLETED_CONTACT_EVENT_TYPE_IDS_JSON")),
    completedContactEventTypes: z.array(z.string()).parse(parseArray("CRM_COMPLETED_CONTACT_EVENT_TYPES_JSON")),
    closedOutcomes: process.env.CRM_CLOSED_OUTCOMES_JSON ? z.array(z.string().min(1)).parse(parseArray("CRM_CLOSED_OUTCOMES_JSON")) : ["Won"],
    eventHistoryComplete: process.env.CRM_EVENT_HISTORY_COMPLETE === "true",
    ...(process.env.CRM_BUSINESS_HOURS_JSON ? { businessHours: businessHoursSchema.parse(JSON.parse(process.env.CRM_BUSINESS_HOURS_JSON)) } : {}),
  };
}
const businessDayCache = new Map<string, Map<number, { opening?: number; closing?: number }>>();
function elapsedHours(start: number, end: number, businessHours?: z.infer<typeof businessHoursSchema>): number {
  if (end <= start) return 0;
  if (!businessHours) return (end - start) / 3_600_000;
  const schedule = businessHoursSchema.parse(businessHours);
  const scheduleKey = JSON.stringify(schedule);
  let intervals = businessDayCache.get(scheduleKey);
  if (!intervals) { intervals = new Map(); businessDayCache.set(scheduleKey, intervals); }
  let milliseconds = 0;
  // Visit each local calendar day once, respecting the configured timezone and DST.
  const first = zonedParts(start, schedule.timeZone), last = zonedParts(end, schedule.timeZone);
  const finish = Date.UTC(last.year, last.month - 1, last.day);
  for (let day = Date.UTC(first.year, first.month - 1, first.day); day <= finish; day += 86_400_000) {
    const date = new Date(day); if (!schedule.weekdays.includes(date.getUTCDay())) continue;
    let interval = intervals.get(day);
    if (!interval) {
      const nextDay = new Date(day + 86_400_000);
      const opening = localToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), schedule.startHour, 0, schedule.timeZone);
      const closing = schedule.endHour === 24
        ? localToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, 0, schedule.timeZone)
        : localToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), schedule.endHour, 0, schedule.timeZone);
      interval = { opening, closing }; intervals.set(day, interval);
    }
    const { opening, closing } = interval;
    if (opening !== undefined && closing !== undefined) milliseconds += Math.max(0, Math.min(end, closing) - Math.max(start, opening));
  }
  return milliseconds / 3_600_000;
}

export type LeadClassification = "recorded_contact" | "scheduled_activity" | "attention_needed" | "closed_opportunity" | "insufficient_evidence";
export interface LeadFinding {
  leadId?: string; classification: LeadClassification; attentionNeeded: boolean; reviewSuggested: boolean; reason: string;
  customerName?: string; title?: string; agents: CrmRecord[]; properties: CrmRecord[]; status?: string; outcome?: string;
  evidence: { createDate?: string; historyAvailable: boolean; historyComplete: boolean; eventCount: number; completedContactEvents: CrmRecord[]; upcomingEvents: CrmRecord[]; ambiguousEvents: number; lastRecordedContact?: string; firstResponseHours?: number; ageHours?: number; minimumCalendarAgeHours?: number };
}
export function auditLeads(dataset: LeadDataset, policy: AuditPolicy = {}) {
  const options = { ...configuredAuditPolicy(), ...policy };
  const now = parseCrmDate(options.now ?? new Date().toISOString()); if (now === undefined) throw new Error("Audit time requires a valid timestamp with timezone.");
  const firstResponseTarget = z.number().positive().parse(options.firstResponseHours ?? 24);
  const inactivityTarget = z.number().positive().parse(options.inactivityHours ?? 168);
  const completedTypes = new Set((options.completedContactEventTypes ?? []).map(normalizeText));
  const closed = new Set((options.closedOutcomes ?? []).map(normalizeText));
  const findings: LeadFinding[] = dataset.leads.map((lead) => {
    const events = records(lead.Events); const historyAvailable = Array.isArray(lead.Events); const historyComplete = historyAvailable && options.eventHistoryComplete === true;
    const contactEvents = events.filter((event) => ((options.completedContactEventTypeIds ?? []).includes(number(event.EventTypeID) ?? -1) || completedTypes.has(normalizeText(event.EventType))) && (parseCrmDate(event.StartDate) ?? -Infinity) <= now);
    const contactsWithDates = contactEvents.map((event) => ({ event, at: parseCrmDate(event.StartDate) })).filter((value): value is { event: CrmRecord; at: number } => value.at !== undefined && value.at <= now).sort((a, b) => a.at - b.at);
    const future = events.filter((event) => (parseCrmDate(event.StartDate) ?? -Infinity) > now);
    const created = parseCrmDate(lead.CreateDate); const latest = contactsWithDates.at(-1); const first = contactsWithDates[0];
    const age = created !== undefined && created <= now ? elapsedHours(created, now, options.businessHours) : undefined;
    // Without a configured tenant timezone, a local ISO timestamp still gives
    // a conservative lower age bound across all UTC offsets (up to UTC-12).
    // Use that bound for review suggestions only, never response-time metrics.
    const unzonedCreation = created === undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(lead.CreateDate)) ? Date.parse(`${String(lead.CreateDate)}Z`) : NaN;
    const minimumCalendarAgeHours = Number.isFinite(unzonedCreation) ? Math.max(0, (now - unzonedCreation - 14 * 3_600_000) / 3_600_000) : undefined;
    const inactivity = latest ? elapsedHours(latest.at, now, options.businessHours) : undefined;
    let classification: LeadClassification = "insufficient_evidence", reason = "Available CRM history does not establish whether contact was completed.";
    if (closed.has(normalizeText(lead.Outcome))) { classification = "closed_opportunity"; reason = `Recorded closed outcome: ${String(lead.Outcome)}.`; }
    else if (latest && inactivity !== undefined && inactivity > inactivityTarget && !future.length) { classification = "attention_needed"; reason = `Last recorded completed contact exceeds the ${inactivityTarget}-hour inactivity target; later offline activity may be unrecorded.`; }
    else if (contactEvents.length) { classification = "recorded_contact"; reason = "Contact is established by a configured, validated completed-contact event type."; }
    else if (future.length) { classification = "scheduled_activity"; reason = "A future event is recorded. Scheduling does not establish completed contact."; }
    else if (historyComplete && age !== undefined && age > firstResponseTarget) { classification = "attention_needed"; reason = `No recorded completed contact in the available history after the ${firstResponseTarget}-hour response target. This is not proof of no offline contact.`; }
    const reviewAge = age ?? (!options.businessHours ? minimumCalendarAgeHours : undefined);
    const reviewSuggested = classification === "insufficient_evidence" && reviewAge !== undefined && reviewAge > firstResponseTarget;
    if (reviewSuggested) reason = `Lead age exceeds the ${firstResponseTarget}-hour review target; needs review because contact evidence is unavailable or ambiguous.`;
    return { leadId: string(lead.Id), classification, attentionNeeded: classification === "attention_needed", reviewSuggested, reason,
      title: string(lead.Title), customerName: string(record(lead.Customer).Name), agents: records(lead.Agents), properties: records(lead.Properties), status: string(lead.CurrentStatus), outcome: string(lead.Outcome),
      evidence: { createDate: string(lead.CreateDate), historyAvailable, historyComplete, eventCount: events.length, completedContactEvents: contactEvents,
        upcomingEvents: future, ambiguousEvents: events.filter((event) => !contactEvents.includes(event) && !future.includes(event)).length,
        lastRecordedContact: latest ? string(latest.event.StartDate) : undefined,
        firstResponseHours: first && created !== undefined && first.at >= created ? elapsedHours(created, first.at, options.businessHours) : undefined, ageHours: age, minimumCalendarAgeHours },
    };
  });
  const counts = Object.fromEntries((["recorded_contact", "scheduled_activity", "attention_needed", "closed_opportunity", "insufficient_evidence"] as const).map((classification) => [classification, findings.filter((finding) => finding.classification === classification).length]));
  return { findings, attentionCandidates: findings.filter((finding) => finding.attentionNeeded || finding.reviewSuggested), counts,
    denominator: findings.length, noRecordedContact: findings.filter((finding) => finding.evidence.completedContactEvents.length === 0).length,
    unknownHistory: findings.filter((finding) => !finding.evidence.historyComplete).length,
    coverage: dataset.coverage, asOf: new Date(now).toISOString(), thresholds: { firstResponseHours: firstResponseTarget, inactivityHours: inactivityTarget, clock: options.businessHours ? "configured business hours" : "elapsed calendar hours" },
    caveat: "No recorded contact does not mean never answered. Status, assignment, LastUpdate and event end times are not contact-completion evidence. Counts cover every opportunity in this returned dataset.",
  };
}

export interface SalesReportOptions { from: string; to?: string; brokerId?: string; broker?: string; wonOutcomes?: string[] }
export function configuredWonOutcomes(): string[] {
  // `Won` was observed in the tenant's read-only production contract check on 2026-09-07.
  return z.array(z.string().min(1)).parse(JSON.parse(process.env.CRM_WON_OUTCOMES_JSON || '["Won"]'));
}
export function buildSalesReport(dataset: LeadDataset, options: SalesReportOptions) {
  const from = bound(options.from), to = bound(options.to, true); if (from === undefined) throw new Error("A report start date is required.");
  if (to !== undefined && from > to) throw new Error("Report from must precede to.");
  const won = new Set((options.wonOutcomes ?? configuredWonOutcomes()).map(normalizeText));
  if (!won.size) throw new Error("Validated CRM won-outcome values must be configured before computing sales outcomes.");
  const seen = new Set<string>(); const rows: CrmRecord[] = [], exceptions: CrmRecord[] = [];
  for (const lead of dataset.leads) {
    if (!won.has(normalizeText(lead.Outcome))) continue;
    const id = string(lead.Id); if (id && seen.has(id)) continue; if (id) seen.add(id);
    const agents = records(lead.Agents);
    if (options.brokerId && agents.length && !agents.some((agent) => String(agent.AgentID) === options.brokerId)) continue;
    if (options.broker && agents.length && !agents.some((agent) => normalizeText(agent.AgentName).includes(normalizeText(options.broker)))) continue;
    const date = parseCrmDate(lead.OutcomeDate);
    const row = { leadId: id, outcome: lead.Outcome, outcomeDate: lead.OutcomeDate, agents, properties: records(lead.Properties), salePrice: lead.SalePrice };
    if (!id || date === undefined) { exceptions.push({ ...row, reason: !id ? "Missing opportunity ID" : "Missing or ambiguous outcome date/timezone" }); continue; }
    if (date < from || (to !== undefined && date > to)) continue;
    if (!agents.length) { exceptions.push({ ...row, reason: "Missing broker attribution" }); if (options.broker || options.brokerId) continue; }
    const price = typeof lead.SalePrice === "number" ? number(lead.SalePrice) : /^\d+(?:\.\d+)?$/.test(String(lead.SalePrice)) ? Number(lead.SalePrice) : undefined;
    if (price === undefined) exceptions.push({ ...row, reason: "Missing or ambiguous sale amount; not included in sum" });
    rows.push({ ...row, amount: price, sharedAgents: agents.length > 1, attribution: "Associated CRM agents; closing roles are not documented" });
  }
  return { reportType: "CRM won-opportunity outcome report", from: options.from, to: options.to,
    rows, exceptions, totals: { wonOpportunities: rows.length, linkedProperties: new Set(rows.flatMap((row) => records(row.properties).map((property) => String(property.PropertyID ?? property.Reference)))).size,
      amountForKnownValues: rows.reduce((sum, row) => sum + (number(row.amount) ?? 0), 0), opportunitiesWithKnownAmount: rows.filter((row) => row.amount !== undefined).length, verifiedTransactions: null },
    coverage: dataset.coverage,
    caveat: "Won outcomes include rental opportunities as well as property sales. Counts deduplicate opportunity IDs and amounts once per opportunity. Linked properties and shared agents are not additional sales. No transaction IDs, currency or closing-role attribution are documented; this is not an authoritative sales/commission ledger.",
  };
}
