import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { callCrmApi, callCrmApiWithPagination } from "../src/client/crm-client.js";
import { fetchPropertyForPdf } from "../src/pdf/property-data.js";
import { assessProperty, searchProperties, resolveExactProperty, matchProperties, resolveVerifiedListingUrl } from "../src/workflows/crm-properties.js";
import { auditLeads, fetchAllLeads, findLeadContacts, queryLeads, buildSalesReport, parseCrmDate, type LeadDataset } from "../src/workflows/crm-leads.js";
import { auditCrmLeadsTool } from "../src/tools/crm-workflows.js";

const originalFetch = globalThis.fetch;
const savedTimezone = process.env.CRM_TIMEZONE;
const savedOldTimezone = process.env.CRM_DATE_TIMEZONE;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedTimezone === undefined) delete process.env.CRM_TIMEZONE; else process.env.CRM_TIMEZONE = savedTimezone;
  if (savedOldTimezone === undefined) delete process.env.CRM_DATE_TIMEZONE; else process.env.CRM_DATE_TIMEZONE = savedOldTimezone;
});
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const property = (overrides = {}) => ({ id: 42, reference: "A-42", type: "Villa", businessType: "Sale", price: 2_500_000, bedrooms: 4, location: { City: "Cascais", Country: "Portugal" }, features_list_enum: ["Pool", "Garage"], ...overrides });
const dataset = (leads: Record<string, unknown>[]): LeadDataset => ({ leads, coverage: { source: "test", fetchedAt: "2026-09-07T12:00:00Z", fetchedRecords: leads.length, complete: false, scope: "test full returned dataset", warnings: [] } });

describe("CRM verified property workflows", () => {
  it("requires villa, exact Cascais city, verified pool and budget together", () => {
    const criteria = { propertyTypes: ["Villa" as const], cities: ["Cascais"], features: ["Pool" as const], price: { max: 3_000_000 } };
    assert.equal(assessProperty(property(), criteria).status, "exact");
    assert.equal(assessProperty(property({ type: "Apartment" }), criteria).status, "excluded");
    assert.equal(assessProperty(property({ location: { City: "Sintra", address: "Road to Cascais" } }), criteria).status, "excluded");
    assert.equal(assessProperty(property({ price: 3_000_001 }), criteria).status, "excluded");
    assert.equal(assessProperty(property({ features_list_enum: [] }), criteria).status, "unverified");
    assert.equal(assessProperty(property({ price: 0 }), criteria).status, "unverified");
  });

  it("does not substitute wrong references and requires both identifiers to agree", async () => {
    globalThis.fetch = async () => json({ Success: {}, PropertyList: [property()], Count: 1 });
    await assert.rejects(() => resolveExactProperty({ reference: "WRONG" }), /No exact property/);
    await assert.rejects(() => resolveExactProperty({ reference: "A-42", propertyId: 43 }), /No exact property/);
    await assert.rejects(() => resolveExactProperty({ reference: "a-42" }), /No exact property/);
    const resolved = await resolveExactProperty({ reference: "A-42", propertyId: 42 });
    assert.equal(resolved.propertyId, 42);
    assert.equal(resolved.property.propertyId, 42);
    const pdf = await fetchPropertyForPdf({ reference: "A-42" });
    assert.equal(pdf.propertyId, resolved.propertyId);
    assert.equal(pdf.price, resolved.property.price);
    assert.equal(pdf.reference, resolved.reference);
  });

  it("normalizes the documented CRM currency code and explicit Portugal country name", () => {
    const criteria = { currency: "EUR" as const, countryCode: "pt" as const };
    assert.equal(assessProperty(property({ currency: "€", priceprefixhelper: "EUR" }), criteria).status, "exact");
    assert.equal(assessProperty(property({ currency: "€" }), criteria).status, "exact");
    assert.equal(assessProperty(property({ currency: "$", priceprefixhelper: "USD" }), criteria).status, "excluded");
    assert.equal(assessProperty(property({ currency: "EUR", location: { City: "Lisboa" } }), criteria).status, "unverified");
  });

  it("ranks preferences only after strict requirements and rejects conflicting ranges", () => {
    const results = matchProperties([property(), property({ id: 43, reference: "A-43", features_list_enum: ["Pool"] }), property({ id: 44, type: "Apartment" })], {
      mandatory: { propertyTypes: ["Villa"], features: ["Pool"] }, preferred: { features: ["Garage"] },
    });
    assert.deepEqual(results.matches.map((match) => match.property.reference), ["A-42", "A-43"]);
    assert.equal(results.excluded.length, 1);
    assert.throws(() => matchProperties([], { mandatory: { price: { min: 100, max: 50 } } }), /Minimum cannot exceed/);
  });

  it("returns only identity-verified configured listing URLs", () => {
    const entry = { propertyId: 42, reference: "A-42", url: "https://bonte.test/property/verified", verifiedAt: "2026-09-07T12:00:00Z" };
    assert.equal(resolveVerifiedListingUrl(property(), [entry]), entry.url);
    assert.equal(resolveVerifiedListingUrl(property({ reference: "OTHER" }), [entry]), undefined);
    assert.equal(resolveVerifiedListingUrl(property(), [{ ...entry, verifiedAt: "not verified" }]), undefined);
    assert.equal(resolveVerifiedListingUrl(property(), [entry, { ...entry, url: "https://bonte.test/other" }]), undefined);
  });

  it("exposes pagination coverage and separates unknown feature evidence from exact matches", async () => {
    globalThis.fetch = async () => json({ Success: {}, Count: 300, PropertyList: [property(), property({ id: 43, reference: "A-43", features_list_enum: [] })] });
    const data = await searchProperties({ criteria: { features: ["Pool"] }, pageSize: 2 });
    assert.equal(data.coverage.complete, false);
    assert.equal(data.coverage.totalRecords, 300);
    assert.equal(data.matches.length, 1);
    assert.equal(data.unverified.length, 1);
    assert.equal(data.nextPage, 2);
  });
});

describe("CRM full-history lead workflows", () => {
  it("keeps all operational history before previews while discarding irrelevant identifiers", async () => {
    let request: Record<string, unknown> = {};
    globalThis.fetch = async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return json({ Success: {}, Opportunities: Array.from({ length: 140 }, (_, index) => ({ Id: String(index), CreateDate: "2026-01-01T00:00:00Z", Description: "Useful buyer requirements", Customer: { Name: "Buyer", EmailAddress: "buyer@example.test", TaxIdentificationNumber: "sensitive" }, Events: [{ EventID: "one", Description: "Full operational detail" }] })) });
    };
    const all = await fetchAllLeads({ createdFrom: "2026-01-01" });
    assert.equal(all.leads.length, 140);
    assert.equal((all.leads[0].Customer as Record<string, unknown>).TaxIdentificationNumber, undefined);
    assert.equal((all.leads[0].Events as Record<string, unknown>[])[0].Description, "Full operational detail");
    assert.equal(request.StartDate, undefined, "Unvalidated server date semantics must not narrow retrieval");
    const output = JSON.parse(String(await auditCrmLeadsTool.invoke({ filters: {}, resultLimit: 5, attentionOnly: false })));
    assert.equal(output.denominator, 140);
    assert.equal(output.findings.length, 5);
    assert.equal(output.previewTruncated, true);
  });

  it("does not confuse status, assignment, scheduled or ended events with completed contact", () => {
    const all = dataset([
      { Id: "contact", CurrentStatus: "Recebido", CreateDate: "2026-09-06T10:00:00Z", Events: [{ EventID: "done", EventTypeID: 77, StartDate: "2026-09-06T11:00:00Z" }] },
      { Id: "past-call", CurrentStatus: "Recebido", CreateDate: "2026-09-01T00:00:00Z", Events: [{ EventTypeID: 2, Title: "Call", StartDate: "2026-09-02T09:00:00Z", EndDate: "2026-09-02T10:00:00Z" }] },
      { Id: "future-call", CreateDate: "2026-09-06T10:00:00Z", Events: [{ EventTypeID: 2, StartDate: "2026-09-08T10:00:00Z" }] },
      { Id: "missing", CurrentStatus: "Assigned", LastUpdate: "2026-09-07T11:00:00Z", CreateDate: "2026-01-01T00:00:00Z" },
    ]);
    const audit = auditLeads(all, { now: "2026-09-07T12:00:00Z", completedContactEventTypeIds: [77], inactivityHours: 168 });
    assert.deepEqual(audit.findings.map((finding) => finding.classification), ["recorded_contact", "insufficient_evidence", "scheduled_activity", "insufficient_evidence"]);
    assert.equal(audit.findings[0].evidence.firstResponseHours, 1);
    assert.equal(audit.findings[3].reviewSuggested, true);
    assert.equal(audit.findings[3].attentionNeeded, false);
    assert.equal(audit.noRecordedContact, 3);
    assert.equal(audit.denominator, 4);
  });

  it("uses a conservative review age without fabricating timezone-specific durations", () => {
    delete process.env.CRM_TIMEZONE; delete process.env.CRM_DATE_TIMEZONE;
    const audit = auditLeads(dataset([{ Id: "old", CreateDate: "2026-01-01T12:00:00.000" }]), { now: "2026-09-07T12:00:00Z" });
    assert.equal(audit.findings[0].reviewSuggested, true);
    assert.equal(audit.findings[0].evidence.ageHours, undefined);
    assert.equal(audit.findings[0].evidence.firstResponseHours, undefined);
    assert.equal(parseCrmDate("2026-09-07T12:00:00.000"), undefined);
    process.env.CRM_TIMEZONE = "Europe/Lisbon";
    assert.equal(parseCrmDate("2026-09-07T12:00:00.000"), Date.parse("2026-09-07T11:00:00Z"));
  });

  it("calculates business-hour response durations over weekends", () => {
    const audit = auditLeads(dataset([{ Id: "business", CreateDate: "2026-09-04T16:00:00Z", Events: [{ EventTypeID: 77, StartDate: "2026-09-07T10:00:00Z" }] }]), {
      now: "2026-09-07T12:00:00Z", completedContactEventTypeIds: [77], businessHours: { timeZone: "UTC", weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 },
    });
    assert.equal(audit.findings[0].evidence.firstResponseHours, 2);
  });

  it("uses local report day boundaries and rejects ambiguous autumn-fold timestamps", () => {
    process.env.CRM_TIMEZONE = "Europe/Lisbon";
    assert.equal(parseCrmDate("2026-10-25T01:30:00"), undefined);
    assert.equal(parseCrmDate("2026-02-30T12:00:00Z"), undefined);
    const lead = { Id: "early-local", Outcome: "Won", OutcomeDate: "2026-07-01T00:30:00", SalePrice: "2100", Agents: [{ AgentID: "a" }] };
    const report = buildSalesReport(dataset([lead]), { from: "2026-07-01", to: "2026-07-01", wonOutcomes: ["Won"] });
    assert.equal(report.totals.wonOpportunities, 1);
  });

  it("checks normalized contacts without claiming a full CRM directory or collapsing opportunities", () => {
    const all = dataset([
      { Id: "one", Customer: { Name: "Ana Silva", EmailAddress: "Ana@Example.test", PhoneNumber: "+351 912 345 678" }, Properties: [{ PropertyID: "1" }] },
      { Id: "two", Customer: { Name: "Ana Silva", EmailAddress: "ana@example.test", PhoneNumber: "00351 912345678" }, Properties: [{ PropertyID: "2" }] },
    ]);
    assert.equal(findLeadContacts(all, { email: "ANA@example.test" }).matches.length, 2);
    assert.equal(findLeadContacts(all, { phone: "+351912345678" }).matches.length, 2);
    assert.equal(findLeadContacts(all, { phone: "912345678" }).matches.length, 0);
    assert.equal(findLeadContacts(all, { name: "Ana" }).matches[0].identityStrength, "name_only");
    assert.equal(queryLeads(all, { email: "ana@example.test" }).length, 2);
  });

  it("reports old leads closed in-period and deduplicates shared-agent amounts with missing-date exceptions", () => {
    const lead = { Id: "won", CreateDate: "2023-01-01T00:00:00Z", Outcome: "Won", OutcomeDate: "2026-04-01T10:00:00Z", SalePrice: "900000", Agents: [{ AgentID: "a" }, { AgentID: "b" }], Properties: [{ PropertyID: "p" }] };
    const report = buildSalesReport(dataset([lead, lead, { ...lead, Id: "undated", OutcomeDate: undefined }, { ...lead, Id: "old", OutcomeDate: "2025-12-31T23:00:00Z" }]), { from: "2026-01-01", brokerId: "a", wonOutcomes: ["Won"] });
    assert.equal(report.totals.wonOpportunities, 1);
    assert.equal(report.totals.amountForKnownValues, 900000);
    assert.equal(report.totals.linkedProperties, 1);
    assert.equal(report.totals.verifiedTransactions, null);
    assert.equal(report.exceptions.length, 1);
    assert.match(report.caveat, /rental/);
  });
});

describe("CRM response coverage failures", () => {
  it("rejects HTTP 200 application errors and warnings without success", async () => {
    globalThis.fetch = async () => json({ Success: null, Warnings: [{ Code: 17, ShortText: "Access denied" }] });
    await assert.rejects(() => callCrmApi({ endpoint: "/api/Leads/List", method: "POST" }), /CRM request rejected: 17: Access denied/);
    globalThis.fetch = async () => json({ Errors: [{ Code: 4, ShortText: "Invalid input" }] });
    await assert.rejects(() => callCrmApi({ endpoint: "/api/Leads/List", method: "POST" }), /Invalid input/);
    globalThis.fetch = async () => json({ Warnings: [{ ShortText: "Missing access" }] });
    await assert.rejects(() => callCrmApi({ endpoint: "/api/Leads/List", method: "POST" }), /Missing access/);
  });

  it("never turns an absent result array into no results", async () => {
    globalThis.fetch = async () => json({ Success: {} });
    await assert.rejects(() => fetchAllLeads(), /missing Opportunities/);
    await assert.rejects(() => searchProperties({ criteria: {} }), /missing PropertyList/);
  });

  it("stops repeated pages without duplicating records and marks incomplete totals", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return json({ Success: {}, Count: 5, PropertyList: [property()] }); };
    const response = await callCrmApiWithPagination({ endpoint: "/api/Property/ListProperties", method: "POST" }, { pageSize: 1 });
    assert.equal(requests, 2);
    assert.equal(response.pagination?.truncated, true);
    assert.equal(response.pagination?.returnedRecords, 1);
    assert.match(response.pagination?.warnings?.join(" ") ?? "", /repeated a page/);
  });

  it("marks early-ending pages incomplete when the server total is larger", async () => {
    globalThis.fetch = async () => json({ Success: {}, Count: 50, PropertyList: [property()] });
    const response = await callCrmApiWithPagination({ endpoint: "/api/Property/ListProperties", method: "POST" }, { pageSize: 100 });
    assert.equal(response.pagination?.truncated, true);
    assert.match(response.pagination?.warnings?.join(" ") ?? "", /reported total/);
  });

  it("does not advertise another page when the last scoped page reaches the total", async () => {
    globalThis.fetch = async () => json({ Success: {}, Count: 2, PropertyList: [property()] });
    const response = await callCrmApiWithPagination({ endpoint: "/api/Property/ListProperties", method: "POST" }, { pageSize: 1, startPage: 2, maxPages: 1 });
    assert.equal(response.pagination?.truncated, true, "Earlier pages are outside this scope");
    assert.equal(response.pagination?.hasMore, false);
    assert.equal(response.pagination?.nextPage, undefined);
  });
});


it("empty optional deployment environment values retain safe CRM defaults", async () => {
  const { configuredAuditPolicy, configuredWonOutcomes } = await import("../src/workflows/crm-leads.js");
  const names = ["CRM_COMPLETED_CONTACT_EVENT_TYPE_IDS_JSON", "CRM_COMPLETED_CONTACT_EVENT_TYPES_JSON", "CRM_WON_OUTCOMES_JSON", "CRM_FIRST_RESPONSE_HOURS", "CRM_INACTIVITY_HOURS"];
  const before = names.map(name => process.env[name]);
  try {
    names.forEach(name => process.env[name] = "");
    assert.deepEqual(configuredWonOutcomes(), ["Won"]);
    assert.deepEqual(configuredAuditPolicy().completedContactEventTypes, []);
    assert.equal(configuredAuditPolicy().firstResponseHours, 24);
  } finally {
    names.forEach((name,index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; });
  }
});
