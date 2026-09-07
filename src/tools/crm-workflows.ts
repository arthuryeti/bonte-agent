import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { callCrmApiWithPagination } from "../client/crm-client.js";
import { crmLanguages } from "../workflows/crm-enums.js";
import { records, record } from "../workflows/crm-common.js";
import { searchProperties, propertySearchSchema, resolveExactProperty, propertySummary, lookupPropertyLocations, buyerBriefSchema, matchProperties } from "../workflows/crm-properties.js";
import { fetchAllLeads, queryLeads, leadQuerySchema, auditLeads, findLeadContacts, buildSalesReport, parseCrmDate, type LeadFinding } from "../workflows/crm-leads.js";

const resultLimit = z.number().int().min(1).max(100).default(20);
async function result(action: () => unknown | Promise<unknown>): Promise<string> {
  try { return JSON.stringify({ ok: true, ...record(await action()) }); }
  catch (error) { return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "CRM workflow failed" }); }
}
function compactFinding(finding: LeadFinding) {
  return { ...finding, evidence: { ...finding.evidence, completedContactEvents: finding.evidence.completedContactEvents.slice(-5), upcomingEvents: finding.evidence.upcomingEvents.slice(0, 5), eventEvidencePreview: true } };
}

export const searchCrmPropertiesTool = tool(async (input) => result(async () => {
  const data = await searchProperties(input);
  const summarize = (assessment: (typeof data.matches)[number]) => ({ ...assessment, property: propertySummary(assessment.property) });
  return { matches: data.matches.map(summarize), unverified: data.unverified.map(summarize), excludedCount: data.excluded.length,
    exactMatchesInScannedRecords: data.matches.length, scannedRecords: data.properties.length, coverage: data.coverage, nextPage: data.nextPage,
    guidance: "Only matches satisfy every mandatory criterion. Unverified records are not exact matches. The server total counts candidates before local verification." };
}), { name: "search_crm_properties", description: "Search Bonte CRM properties with documented enum filters and code-verified mandatory criteria. Exact city names are verified from location fields; absent feature evidence is unknown. Keep ordinary searches paginated. External Casafari market inventory is not available.", schema: propertySearchSchema });

export const getVerifiedPropertyTool = tool(async (input) => result(async () => {
  const verified = await resolveExactProperty(input);
  return { ...verified, property: { ...propertySummary(verified.property), locale: verified.property.locale, listing_agent: verified.property.listing_agent, files: verified.property.files } };
}), { name: "get_verified_property", description: "Resolve a property reference or numeric ID exactly before follow-up materials, registration or scheduling. Both identifiers must refer to the same record. Returns verified identity, source time, facts and configured public listing URL.", schema: z.object({ reference: z.string().trim().min(1).optional(), propertyId: z.number().int().positive().optional(), language: z.enum(crmLanguages).default("en") }) });

export const lookupCrmLocationsTool = tool(async (input) => result(async () => ({ locations: await lookupPropertyLocations(input) })), {
  name: "lookup_crm_locations", description: "Retrieve documented CRM location hierarchy and IDs. Use returned IDs to disambiguate locations for strict property searches; do not invent IDs.",
  schema: z.object({ countryCode: z.enum(["pt", "es", "fr", "it", "pa", "br"]).default("pt"), parentId: z.number().int().nonnegative().optional(), level: z.number().int().min(0).max(10).optional() }),
});

export const queryCrmLeadsTool = tool(async (input) => result(async () => {
  const dataset = await fetchAllLeads(input.filters);
  const leads = queryLeads(dataset, input.filters).sort((left, right) => {
    const a = parseCrmDate(left.CreateDate), b = parseCrmDate(right.CreateDate);
    // ISO local dates can be sorted lexically within a tenant, without making duration claims.
    return a !== undefined && b !== undefined ? b - a : String(right.CreateDate ?? "").localeCompare(String(left.CreateDate ?? ""));
  });
  return { leads: leads.slice(0, input.resultLimit), matchedRecords: leads.length, returnedRecords: Math.min(leads.length, input.resultLimit),
    previewTruncated: leads.length > input.resultLimit, coverage: dataset.coverage,
    dateFilterExceptions: input.filters.createdFrom || input.filters.createdTo ? dataset.leads.filter((lead) => parseCrmDate(lead.CreateDate) === undefined).length : 0 };
}), { name: "query_crm_leads", description: "Fetch full available opportunity descriptions and history, then filter by customer, broker, source, status, outcome or creation date. Compute totals before limiting the returned preview. Missing Events does not mean no contact. Date ranges use creation dates locally; for closed outcomes use report_crm_sales_outcomes.", schema: z.object({ filters: leadQuerySchema.default({}), resultLimit }) });

export const auditCrmLeadsTool = tool(async (input) => result(async () => {
  const all = await fetchAllLeads(input.filters);
  const dataset = { ...all, leads: queryLeads(all, input.filters) };
  const audit = auditLeads(dataset, { ...(input.firstResponseHours ? { firstResponseHours: input.firstResponseHours } : {}), ...(input.inactivityHours ? { inactivityHours: input.inactivityHours } : {}) });
  const findings = input.attentionOnly ? audit.attentionCandidates : audit.findings;
  return { ...audit, findings: findings.slice(0, input.resultLimit).map(compactFinding), attentionCandidates: undefined,
    matchingFindings: findings.length, returnedFindings: Math.min(findings.length, input.resultLimit), previewTruncated: findings.length > input.resultLimit };
}), { name: "audit_crm_lead_followups", description: "Audit the full returned lead dataset in code. Distinguish recorded contact, scheduling, evidence-based attention, closed outcomes and insufficient evidence. Missing contact history can prompt review; never call it proof of never answered or use status/assignment as completion. Calendar-hour targets can be overridden; validated event types, closed outcomes and working hours are server configuration.",
  schema: z.object({ filters: leadQuerySchema.default({}), firstResponseHours: z.number().positive().max(8760).optional(), inactivityHours: z.number().positive().max(8760).optional(), attentionOnly: z.boolean().default(true), resultLimit }) });

export const checkCrmContactTool = tool(async (input) => result(async () => {
  const data = findLeadContacts(await fetchAllLeads(), input);
  return { ...data, matches: data.matches.slice(0, input.resultLimit), totalMatches: data.matches.length, previewTruncated: data.matches.length > input.resultLimit };
}), { name: "check_crm_contact", description: "Check normalized email/phone and possible name matches across the full available lead history. Distinguish an existing contact from a new opportunity. A negative result is scoped to lead customers, not all CRM contacts/developers/owners. Names alone do not establish identity.",
  schema: z.object({ name: z.string().trim().min(1).optional(), email: z.string().email().optional(), phone: z.string().min(5).optional(), resultLimit }) });

export const matchCrmPropertiesTool = tool(async (input) => result(async () => {
  const search = await searchProperties({ criteria: input.brief.mandatory, complete: true, pageSize: 100, language: input.language, maxPages: input.maxPages });
  const matching = matchProperties(search.properties, input.brief);
  const summarize = (match: (typeof matching.matches)[number]) => ({ ...match, property: propertySummary(match.property) });
  return { matches: matching.matches.slice(0, input.resultLimit).map(summarize), unverified: matching.unverified.slice(0, input.resultLimit).map(summarize),
    exactMatchesInScannedRecords: matching.matches.length, unverifiedCount: matching.unverified.length, excludedCount: matching.excluded.length,
    previewTruncated: matching.matches.length > input.resultLimit, coverage: search.coverage,
    guidance: "Mandatory requirements were applied first; preferred requirements rank exact matches. Unknown features are not confirmed matches. No inferred buyer requirement became mandatory." };
}), { name: "match_crm_properties_to_buyer", description: "Match a buyer's explicit mandatory and preferred brief against all relevant available CRM inventory pages. Return ranked verified matches, explain preferences, and separate unknown criteria. Use the user's stated or saved brief; do not silently infer mandatory requirements.",
  schema: z.object({ brief: buyerBriefSchema, language: z.enum(crmLanguages).default("en"), maxPages: z.number().int().min(1).max(100).default(100), resultLimit }) });

export const reportCrmSalesTool = tool(async (input) => result(async () => {
  // Never use lead creation-date filters for a closing-date question.
  const report = buildSalesReport(await fetchAllLeads(), input);
  return { ...report, rows: report.rows.slice(0, input.resultLimit), exceptions: report.exceptions.slice(0, input.resultLimit),
    exceptionCount: report.exceptions.length, previewTruncated: report.rows.length > input.resultLimit || report.exceptions.length > input.resultLimit };
}), { name: "report_crm_sales_outcomes", description: "Compute CRM won-opportunity outcomes by OutcomeDate and associated broker over all returned leads, including old leads closing recently. Deduplicate opportunities/amounts. Won includes rentals; it is not a verified property-sales ledger. Missing dates, timezone, amounts and broker attribution appear as exceptions. Uses tenant-validated outcome values configured on the server.",
  schema: z.object({ from: z.string().min(10), to: z.string().min(10).optional(), brokerId: z.string().optional(), broker: z.string().optional(), resultLimit }) });

export const listCrmAgentsTool = tool(async (input) => result(async () => {
  const response = await callCrmApiWithPagination({ endpoint: "/api/Entity/GetAgents", method: "POST", body: { Lang: input.language, EntitySearchFilters: { Name: input.name } } });
  return { agents: records(record(response.data).Entities).map((agent) => ({ id: agent.EntityID ?? agent.EntityId, name: agent.EntityName ?? agent.Name, email: agent.EmailAddress ?? agent.Email, type: agent.EntityType })), coverage: response.pagination };
}), { name: "list_crm_agents", description: "Find CRM agents and their verified IDs/email addresses for assignment. GetAgents searches agents, not the general customer/developer directory.", schema: z.object({ name: z.string().trim().min(1).optional(), language: z.enum(crmLanguages).default("en") }) });

export const crmWorkflowTools = [searchCrmPropertiesTool, getVerifiedPropertyTool, lookupCrmLocationsTool, queryCrmLeadsTool, auditCrmLeadsTool, checkCrmContactTool, matchCrmPropertiesTool, reportCrmSalesTool, listCrmAgentsTool];
