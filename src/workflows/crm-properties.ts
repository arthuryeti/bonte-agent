import * as z from "zod";
import { readFileSync } from "node:fs";
import { callCrmApi, callCrmApiWithPagination, CrmApiError } from "../client/crm-client.js";
import { businessTypes, propertyTypes, propertyFeatures, crmLanguages } from "./crm-enums.js";
import { record, records, string, number, normalizeText, crmWarnings, type CrmRecord, type DataCoverage } from "./crm-common.js";

const rangeSchema = z.object({ min: z.number().nonnegative().optional(), max: z.number().nonnegative().optional() })
  .refine((range) => range.min === undefined || range.max === undefined || range.min <= range.max, "Minimum cannot exceed maximum.");
const integers = z.array(z.number().int().positive()).max(100);
export const propertyCriteriaSchema = z.object({
  businessTypes: z.array(z.enum(businessTypes)).max(6).optional(),
  propertyTypes: z.array(z.enum(propertyTypes)).max(36).optional(),
  features: z.array(z.enum(propertyFeatures)).max(80).optional(),
  cities: z.array(z.string().trim().min(1)).max(20).optional().describe("Exact CRM city names; title/address text is never used as city evidence."),
  localities: z.array(z.string().trim().min(1)).max(20).optional(),
  countryCode: z.enum(["pt", "es", "fr", "it", "pa", "br"]).optional(),
  locationIds: integers.optional(), cityIds: integers.optional(), localityIds: integers.optional(),
  price: rangeSchema.optional(), bedrooms: rangeSchema.optional(), bathrooms: rangeSchema.optional(),
  livingArea: rangeSchema.optional(), totalArea: rangeSchema.optional(), plotArea: rangeSchema.optional(),
  active: z.boolean().optional(), sold: z.boolean().optional(), published: z.boolean().optional(),
  agentId: z.number().int().positive().optional(),
}).strict();
export type PropertyCriteria = z.infer<typeof propertyCriteriaSchema>;
export const buyerBriefSchema = z.object({
  mandatory: propertyCriteriaSchema,
  preferred: propertyCriteriaSchema.optional(),
}).strict();
export type BuyerBrief = z.infer<typeof buyerBriefSchema>;
export const propertySearchSchema = z.object({
  criteria: propertyCriteriaSchema,
  language: z.enum(crmLanguages).default("en"),
  page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  complete: z.boolean().default(false).describe("Fetch all relevant pages for explicit complete exports or matching. Ordinary searches use a single page."),
  maxPages: z.number().int().min(1).max(100).default(100),
});
export type PropertySearchInput = z.input<typeof propertySearchSchema>;

export interface VerifiedListingMapping { propertyId?: number; reference?: string; url: string; verifiedAt: string }
export interface VerifiedProperty { property: CrmRecord; propertyId: number; reference: string; sourceTime: string; listingUrl?: string }
export interface CriterionEvidence { criterion: string; status: "pass" | "fail" | "unknown"; expected: unknown; actual?: unknown; source: string }
export interface PropertyAssessment { property: CrmRecord; status: "exact" | "excluded" | "unverified"; evidence: CriterionEvidence[] }

export function canonicalProperty(property: CrmRecord): CrmRecord {
  // Production emits `id`; prefer the synchronization ID when a deployment
  // supplies the separately documented `propertyId` field.
  const documented = number(property.propertyId);
  const deployed = number(property.id);
  return { ...property, propertyId: documented ?? deployed };
}

function sameReference(left: unknown, right: unknown): boolean {
  return !!string(left) && !!string(right) && string(left) === string(right);
}

/** Mapping entries are trusted server configuration after page/identity verification. */
export function resolveVerifiedListingUrl(property: CrmRecord, mappings: VerifiedListingMapping[]): string | undefined {
  property = canonicalProperty(property);
  const matches = mappings.filter((mapping) => {
    if (mapping.propertyId === undefined && !mapping.reference) return false;
    if (mapping.propertyId !== undefined && mapping.propertyId !== number(property.propertyId)) return false;
    if (mapping.reference && !sameReference(mapping.reference, property.reference)) return false;
    if (!Number.isFinite(Date.parse(mapping.verifiedAt))) return false;
    try { const url = new URL(mapping.url); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
  });
  const urls = [...new Set(matches.map((mapping) => mapping.url))];
  return urls.length === 1 ? urls[0] : undefined;
}

export function configuredListingMappings(): VerifiedListingMapping[] {
  if (!process.env.CRM_LISTING_URLS_JSON && !process.env.CRM_LISTING_URLS_PATH) return [];
  try {
    return z.array(z.object({ propertyId: z.number().int().positive().optional(), reference: z.string().optional(), url: z.string().url(), verifiedAt: z.string() }))
      .parse(JSON.parse(process.env.CRM_LISTING_URLS_JSON || readFileSync(process.env.CRM_LISTING_URLS_PATH!, "utf8")));
  } catch { throw new Error("CRM listing URL configuration must contain a readable, valid verified mapping (CRM_LISTING_URLS_JSON or CRM_LISTING_URLS_PATH)."); }
}

export async function resolveExactProperty(request: { reference?: string; propertyId?: number; language?: string }): Promise<VerifiedProperty> {
  const reference = string(request.reference);
  if (!reference && request.propertyId === undefined) throw new Error("Provide a property reference or propertyId.");
  if (request.propertyId !== undefined && (!Number.isInteger(request.propertyId) || request.propertyId <= 0)) throw new Error("propertyId must be a positive integer.");
  const language = z.enum(crmLanguages).parse(request.language ?? "en");
  const response = await callCrmApiWithPagination({
    endpoint: "/api/Property/ListProperties", method: "POST", body: {
      ...(reference ? { Reference: reference } : {}), ...(request.propertyId ? { PropertyId: request.propertyId } : {}),
      PropertyIncludes: { IncludeFeatures: true, IncludeBrokers: true, IncludeAgency: true, UseHtmlDescription: true, IncludeFeaturesByCategory: true }, Lang: language,
    },
  }, { pageSize: 100, maxPages: 10 });
  const properties = records(record(response.data).PropertyList).map(canonicalProperty);
  const exact = properties.filter((property) => (!reference || sameReference(property.reference, reference))
    && (request.propertyId === undefined || property.propertyId === request.propertyId));
  const identities = new Set(exact.map((property) => `${property.propertyId}:${String(property.reference)}`));
  if (identities.size !== 1 || !exact.length || response.pagination?.truncated) {
    throw new Error(exact.length ? "Property identity is ambiguous or the lookup is incomplete. Resolve a verified propertyId before continuing."
      : `No exact property found for ${reference ?? `ID ${request.propertyId}`}${reference && request.propertyId ? ` and ID ${request.propertyId}` : ""}. Returned alternatives were not substituted.`);
  }
  const property = exact[0];
  const propertyId = number(property.propertyId);
  const resolvedReference = string(property.reference);
  if (!propertyId || !resolvedReference) throw new CrmApiError("Property response lacks a stable propertyId/reference.", undefined, "contract");
  return { property, propertyId, reference: resolvedReference, sourceTime: new Date().toISOString(), listingUrl: resolveVerifiedListingUrl(property, configuredListingMappings()) };
}

function normalizedEnum(value: unknown): string { return normalizeText(value).replace(/[^a-z0-9]/g, ""); }
function activeFlag(property: CrmRecord): boolean | undefined {
  if (typeof property.active === "boolean") return property.active;
  const configured = process.env.CRM_PROPERTY_ACTIVE_STATUSES_JSON;
  if (!configured) return property.status === "Active" ? true : undefined;
  let statuses: Record<string, boolean>;
  try { statuses = z.record(z.boolean()).parse(JSON.parse(configured)); } catch { throw new Error("CRM_PROPERTY_ACTIVE_STATUSES_JSON must map verified status values to booleans."); }
  return statuses[String(property.status)];
}

export function assessProperty(property: CrmRecord, input: PropertyCriteria): PropertyAssessment {
  property = canonicalProperty(property);
  const criteria = propertyCriteriaSchema.parse(input);
  const evidence: CriterionEvidence[] = [];
  const test = (criterion: string, expected: unknown, actual: unknown, source: string, pass?: boolean) => evidence.push({
    criterion, expected, actual, source, status: actual === undefined ? "unknown" : pass ? "pass" : "fail",
  });
  if (!number(property.propertyId) || !string(property.reference)) test("identity", "Stable property ID and reference", undefined, "propertyId/id + reference");
  for (const [criterion, field] of [["businessTypes", "businessType"], ["propertyTypes", "type"]] as const) {
    const expected = criteria[criterion];
    if (expected?.length) { const actual = string(property[field]); test(criterion, expected, actual, field, expected.some((value) => normalizedEnum(value) === normalizedEnum(actual))); }
  }
  const location = record(property.location);
  const inner = record(location.InnerLocation);
  for (const [criterion, fields] of [["cities", ["cityName", "City"]], ["localities", ["localityName", "Locality"]]] as const) {
    const expected = criteria[criterion];
    if (expected?.length) { const actual = fields.map((field) => string(location[field])).find(Boolean); test(criterion, expected, actual, `location.${fields.join("/")}`, expected.some((value) => normalizeText(value) === normalizeText(actual))); }
  }
  if (criteria.countryCode) test("countryCode", criteria.countryCode, string(location.countryCode), "location.countryCode", normalizeText(criteria.countryCode) === normalizeText(location.countryCode));
  for (const [criterion, actual, source] of [["locationIds", number(location.locationId), "location.locationId"], ["cityIds", number(inner.CityId), "location.InnerLocation.CityId"], ["localityIds", number(inner.LocalityId), "location.InnerLocation.LocalityId"]] as const) {
    const expected = criteria[criterion]; if (expected?.length) test(criterion, expected, actual, source, actual !== undefined && expected.includes(actual));
  }
  for (const [criterion, field] of [["price", "price"], ["bedrooms", "bedrooms"], ["bathrooms", "bathrooms"], ["livingArea", "living_area"], ["totalArea", "total_area"], ["plotArea", "plot_area"]] as const) {
    const expected = criteria[criterion]; if (!expected || (expected.min === undefined && expected.max === undefined)) continue;
    // Casafari commonly uses zero for price-on-application; it cannot prove a budget match.
    const value = number(property[field]); const actual = field === "price" && value === 0 ? undefined : value;
    test(criterion, expected, actual, field, actual !== undefined && (expected.min === undefined || actual >= expected.min) && (expected.max === undefined || actual <= expected.max));
  }
  const features = Array.isArray(property.features_list_enum) ? property.features_list_enum : [];
  for (const feature of criteria.features ?? []) {
    const explicit = record(property.features)[feature];
    const found = features.some((value) => normalizedEnum(value) === normalizedEnum(feature));
    const actual = typeof explicit === "boolean" ? explicit : found ? true : undefined;
    test(`feature:${feature}`, true, actual, "features_list_enum", actual === true);
  }
  for (const [criterion, field] of [["sold", "sold"], ["published", "visibleOnWebsite"]] as const) {
    if (criteria[criterion] !== undefined) { const actual = typeof property[field] === "boolean" ? property[field] : undefined; test(criterion, criteria[criterion], actual, field, actual === criteria[criterion]); }
  }
  if (criteria.active !== undefined) { const actual = activeFlag(property); test("active", criteria.active, actual, "active or validated status mapping", actual === criteria.active); }
  if (criteria.agentId !== undefined) {
    const agents = records(property.listing_agent); const ids = agents.map((agent) => number(agent.id) ?? number(agent.AgentId) ?? number(agent.AgentID) ?? number(agent.EntityId)).filter((id) => id !== undefined);
    test("agentId", criteria.agentId, ids.length ? ids : undefined, "listing_agent", ids.includes(criteria.agentId));
  }
  return { property, evidence, status: evidence.some((item) => item.status === "fail") ? "excluded" : evidence.some((item) => item.status === "unknown") ? "unverified" : "exact" };
}

function criteriaToRequest(criteria: PropertyCriteria): CrmRecord {
  const body: CrmRecord = {};
  for (const [key, api] of [["businessTypes", "BusinessTypeIds"], ["propertyTypes", "PropertyTypeIds"], ["features", "DetailIds"], ["active", "Active"], ["sold", "Sold"], ["published", "VisibleOnWebsite"], ["agentId", "AgentId"]] as const) {
    if (criteria[key] !== undefined) body[api] = criteria[key];
  }
  if (criteria.countryCode || criteria.locationIds?.length) body.Locations = { CountryCode: criteria.countryCode, LocationIds: criteria.locationIds };
  if (criteria.cityIds?.length || criteria.localityIds?.length) body.InnertLocations = { CityIds: criteria.cityIds, LocalityIds: criteria.localityIds };
  for (const [key, min, max] of [["price", "PriceFrom", "PriceTo"], ["bedrooms", "MinBedrooms", "MaxBedrooms"], ["bathrooms", "MinBathrooms", "MaxBathrooms"], ["livingArea", "MinLivingArea", "MaxLivingArea"], ["plotArea", "MinPlotArea", "MaxPlotArea"], ["totalArea", "MinTotalArea", "MaxTotalArea"]] as const) {
    if (criteria[key]?.min !== undefined) body[min] = criteria[key]!.min;
    if (criteria[key]?.max !== undefined) body[max] = criteria[key]!.max;
  }
  // FreeText can narrow retrieval, but only exact location fields establish a city match.
  if (criteria.cities?.length === 1) body.FreeText = criteria.cities[0];
  return body;
}

export async function searchProperties(input: PropertySearchInput) {
  const options = propertySearchSchema.parse(input);
  const request = { endpoint: "/api/Property/ListProperties", method: "POST" as const, body: {
    ...criteriaToRequest(options.criteria), PropertyIncludes: { IncludeFeatures: true, IncludeBrokers: true, IncludeFeaturesByCategory: true },
    Lang: options.language, SequenceNmbr: options.page, MaxResponses: options.pageSize,
  } };
  const response = await callCrmApiWithPagination(request, { pageSize: options.pageSize, startPage: options.page, maxPages: options.complete ? options.maxPages : 1 });
  const data = record(response.data);
  const returned = records(data.PropertyList).map(canonicalProperty);
  const seen = new Set<string>();
  const properties = returned.filter((property) => {
    const identity = number(property.propertyId) ? `id:${String(property.propertyId)}` : string(property.reference) ? `reference:${String(property.reference)}` : undefined;
    if (!identity) return true;
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
  const duplicates = returned.length - properties.length;
  const assessments = properties.map((property) => assessProperty(property, options.criteria));
  const coverage: DataCoverage = {
    source: "Casafari CRM ListProperties", fetchedAt: new Date().toISOString(), fetchedRecords: properties.length,
    totalRecords: response.pagination?.totalRecords, complete: !response.pagination?.truncated && !duplicates,
    scope: "CRM inventory matching server filters; city and mandatory criteria verified locally on scanned records",
    warnings: [...crmWarnings(data), ...(response.pagination?.warnings ?? []), ...(duplicates ? [`Removed ${duplicates} overlapping property IDs; inventory coverage requires another refresh.`] : [])],
  };
  return { properties, matches: assessments.filter((item) => item.status === "exact"), unverified: assessments.filter((item) => item.status === "unverified"), excluded: assessments.filter((item) => item.status === "excluded"), coverage, nextPage: response.pagination?.nextPage };
}

export function matchProperties(properties: CrmRecord[], input: BuyerBrief) {
  const brief = buyerBriefSchema.parse(input);
  const ranked = properties.map((property) => {
    const mandatory = assessProperty(property, brief.mandatory);
    const preferred = assessProperty(property, brief.preferred ?? {});
    const score = preferred.evidence.filter((evidence) => evidence.status === "pass").length;
    return { ...mandatory, score, preferredEvidence: preferred.evidence };
  }).sort((a, b) => b.score - a.score || String(a.property.reference).localeCompare(String(b.property.reference)));
  return { matches: ranked.filter((item) => item.status === "exact"), unverified: ranked.filter((item) => item.status === "unverified"), excluded: ranked.filter((item) => item.status === "excluded") };
}

export function propertySummary(property: CrmRecord) {
  property = canonicalProperty(property);
  return { propertyId: property.propertyId, reference: property.reference, type: property.type, businessType: property.businessType,
    price: property.price_visible === false ? undefined : property.price, priceVisible: property.price_visible, currency: property.currency,
    bedrooms: property.bedrooms, bathrooms: property.bathrooms, livingArea: property.living_area, totalArea: property.total_area, plotArea: property.plot_area,
    location: property.location, features: property.features_list_enum, sold: property.sold, published: property.visibleOnWebsite,
    photos: records(property.photos).slice(0, 3), listingUrl: resolveVerifiedListingUrl(property, configuredListingMappings()) };
}

export async function lookupPropertyLocations(options: { countryCode?: "pt" | "es" | "fr" | "it" | "pa" | "br"; parentId?: number; level?: number }) {
  const response = await callCrmApi({ endpoint: "/api/Property/Location", method: "POST", body: { CountryCode: options.countryCode ?? "pt", ParentId: options.parentId, Level: options.level } });
  if (!Array.isArray(record(response.data).Locations)) throw new CrmApiError("CRM location response is missing Locations.", undefined, "contract");
  return response.data;
}
