import { z } from "zod";
import { record, string, number, normalizeText, type CrmRecord } from "./crm-common.js";
import { resolveExactProperty } from "./crm-properties.js";
import { idealistaGet, idealistaListingUrl } from "./idealista-client.js";
export { idealistaListingUrl } from "./idealista-client.js";

// Contract: Happy Endpoint's Idealista OpenAPI (8 Sep 2026), with live Portugal search verification (9 Sep 2026).
const types = ["flat", "penthouse", "duplex", "studio", "chalet", "countryHouse"] as const;
const features = z.object({ pool: z.boolean().optional(), parking: z.boolean().optional(), lift: z.boolean().optional(), terrace: z.boolean().optional(), balcony: z.boolean().optional(), garden: z.boolean().optional() }).strict();
const subjectSchema = z.object({
  country: z.literal("pt").optional(),
  location: z.string().trim().min(1).max(100).optional().describe("Smallest known locality/neighbourhood, including municipality. Never silently broaden it."),
  propertyType: z.enum(types).optional().describe("flat=apartment; chalet=house/villa; countryHouse=rural house."),
  bedrooms: z.number().int().min(0).max(30).optional(),
  areaM2: z.number().positive().max(100_000).optional(),
  areaBasis: z.enum(["built", "usable"]).optional().describe("Must be verified from user/source. Idealista search uses built area; do not equate CRM total_area with built area."),
  bathrooms: z.number().int().min(0).max(30).optional(),
  plotAreaM2: z.number().positive().max(10_000_000).optional(),
  condition: z.enum(["good", "renovation", "new_build"]).optional(),
  features: features.optional(),
}).strict();
export const marketResearchSchema = z.object({
  reference: z.string().trim().min(1).max(120).optional(),
  propertyId: z.number().int().positive().optional(),
  idealistaUrl: z.string().url().max(500).optional(),
  subject: subjectSchema.default({}).describe("Facts supplied by the user; explicit corrections override source facts. Never invent missing inputs."),
  locationId: z.string().regex(/^0-EU-PT(?:-\d+)+$/).optional().describe("Only an ID returned by this tool's location choices; reverified on every call."),
  requiredFeatures: features.optional().describe("Only features explicitly required to match; absent evidence is not a match."),
}).refine(v => !v.idealistaUrl || (!v.reference && !v.propertyId), "Supply a CRM identity or an Idealista URL, not both.");
type Subject = z.infer<typeof subjectSchema>;
export type MarketResearchInput = z.input<typeof marketResearchSchema>;
const locationSchema = z.object({ name: z.string().min(1).max(300), locationId: z.string().regex(/^0-EU-PT(?:-\d+)+$/), subTypeText: z.string().optional() });
type Location = z.infer<typeof locationSchema>;

export function marketResearchStatus() {
  return { provider: "Idealista via Happy Endpoint / RapidAPI", configured: Boolean(process.env.RAPIDAPI_KEY?.trim()),
    scope: "Portugal residential sale asking prices in EUR", connection: "not_checked_by_status",
    missing: process.env.RAPIDAPI_KEY?.trim() ? [] : ["RAPIDAPI_KEY and an active Happy Endpoint Idealista subscription"],
    next: "Use research_property_market for estimates or match_saved_buyer for buyer matching; configuration alone does not prove provider connectivity." };
}

function conditionOf(row: CrmRecord): Subject["condition"] {
  if (row.newDevelopment === true) return "new_build";
  return row.status === "good" ? "good" : row.status === "renew" ? "renovation" : undefined;
}
function listingFeatures(row: CrmRecord): z.infer<typeof features> {
  const source = record(row.features);
  const bool = (v: unknown) => typeof v === "boolean" ? v : undefined;
  return { lift: bool(row.hasLift), parking: bool(record(row.parkingSpace).hasParkingSpace),
    pool: bool(source.hasSwimmingPool), terrace: bool(source.hasTerrace), balcony: bool(source.hasBalcony) ?? bool(record(row.moreCharacteristics).hasBalcony), garden: bool(source.hasGarden) };
}

async function resolveSubject(input: z.infer<typeof marketResearchSchema>, signal?: AbortSignal) {
  let facts: Subject = {};
  let source: CrmRecord = { kind: "user" };
  let selfUrl: string | undefined;
  if (input.reference || input.propertyId) {
    const verified = await resolveExactProperty(input);
    const p = verified.property, location = record(p.location);
    if (p.businessType !== "Sale") throw new Error("Market research currently supports properties for sale only.");
    if (!["pt", "portugal"].includes(normalizeText(location.countryCode ?? location.Country))) throw new Error("Confirm the CRM property's country is Portugal before researching it.");
    const mapping: Record<string, Subject["propertyType"]> = { Apartment: "flat", Villa: "chalet", Townhouse: "chalet", CountryHouse: "countryHouse", Penthouse: "penthouse", Duplex: "duplex", Studio: "studio" };
    const condition: Record<string, Subject["condition"]> = { New: "new_build", NewBuild: "new_build", ToRefurbish: "renovation", Renovated: "good", Refurbished: "good", VeryGood: "good", InGoodCondition: "good", InExcellentCondition: "good" };
    if (["UnderConstruction", "Project", "Ruin"].includes(String(p.condition_type))) throw new Error("This property's construction stage requires separate comparables; the standard finished-home estimate is unavailable.");
    const crmFeatures = Array.isArray(p.features_list_enum) ? p.features_list_enum : [];
    const present = (name: string) => crmFeatures.includes(name) ? true : undefined;
    facts = { country: "pt", propertyType: mapping[String(p.type)], bedrooms: number(p.bedrooms), bathrooms: number(p.bathrooms),
      location: [string(location.localityName ?? location.Locality), string(location.cityName ?? location.City)].filter(Boolean).join(", ") || undefined,
      plotAreaM2: number(p.plot_area) || undefined, condition: condition[String(p.condition_type)],
      features: { pool: present("Pool"), parking: present("Garage"), lift: present("Lift"), terrace: present("Terrace"), balcony: present("Balcony"), garden: present("Garden") } };
    source = { kind: "crm", reference: verified.reference, propertyId: verified.propertyId, fetchedAt: verified.sourceTime,
      areaEvidence: { livingArea: p.living_area, totalArea: p.total_area, note: "Confirm built area; CRM total_area is not automatically treated as built area." } };
    selfUrl = idealistaListingUrl(verified.listingUrl);
  } else if (input.idealistaUrl) {
    selfUrl = idealistaListingUrl(input.idealistaUrl);
    if (!selfUrl) throw new Error("Supply a valid HTTPS Idealista Portugal property URL.");
    const data = await idealistaGet("/property-details-by-url", { url: selfUrl, language: "en" }, signal);
    const p = record(data.property), more = record(p.moreCharacteristics), id = selfUrl.split("/").at(-2);
    if (data.region !== "pt" || String(data.adId) !== id || String(p.adid) !== id || p.country !== "pt" || p.operation !== "sale") throw new Error("Idealista did not return the requested Portuguese sale listing.");
    const type = z.enum(types).safeParse(p.extendedPropertyType);
    facts = { country: "pt", propertyType: type.success ? type.data : undefined, bedrooms: number(more.roomNumber), bathrooms: number(more.bathNumber),
      areaM2: number(more.constructedArea), areaBasis: number(more.constructedArea) ? "built" : undefined,
      condition: conditionOf(p), features: listingFeatures({ ...p, hasLift: more.hasLift }) };
    source = { kind: "idealista", url: selfUrl, fetchedAt: new Date().toISOString(), locationHint: record(p.ubication).subtitle,
      note: "Confirm the smallest locality; a listing's free-text address is not administrative location evidence." };
  }
  const subject = { ...facts, ...input.subject, features: { ...facts.features, ...input.subject.features } };
  return { subject, source, selfUrl };
}

const listingSchema = z.object({
  propertyCode: z.string().regex(/^[1-9]\d*$/), url: z.string(), country: z.literal("pt"), operation: z.literal("sale"),
  propertyType: z.enum(types), size: z.number().positive().max(100_000), price: z.number().positive().max(1_000_000_000),
  rooms: z.number().int().min(0).max(30), bathrooms: z.number().int().nonnegative().optional(),
}).passthrough();

function inLocation(row: CrmRecord, location: Location): boolean {
  if (typeof row.locationId === "string") return row.locationId === location.locationId || row.locationId.startsWith(`${location.locationId}-`);
  const labels = [row.neighborhood, row.district, row.municipality, row.province].map(normalizeText).filter(Boolean);
  const expected = location.name.split(",").map(normalizeText).filter(v => v && v !== "portugal");
  return expected.length > 0 && expected.every(v => labels.includes(v));
}

export function assessComparables(rows: unknown[], subject: Subject, location: Location, required: z.infer<typeof features> = {}, selfUrl?: string) {
  const ids = new Set<string>(), urls = new Set<string>(), fingerprints = new Set<string>();
  const excluded: Record<string, number> = {};
  const reject = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  const candidates = [];
  for (const raw of rows) {
    const parsed = listingSchema.safeParse(raw);
    if (!parsed.success) { reject("invalid_or_unsupported_listing"); continue; }
    const p = parsed.data, url = idealistaListingUrl(p.url);
    if (!url || url.split("/").at(-2) !== p.propertyCode) { reject("invalid_listing_link"); continue; }
    if (url === selfUrl) { reject("subject_listing"); continue; }
    if (ids.has(p.propertyCode) || urls.has(url)) { reject("duplicate"); continue; }
    ids.add(p.propertyCode); urls.add(url);
    const priceInfo = record(record(p.priceInfo).price);
    if ((priceInfo.currencySuffix !== undefined && priceInfo.currencySuffix !== "€") || (p.currency !== undefined && p.currency !== "EUR")
      || (priceInfo.amount !== undefined && priceInfo.amount !== p.price)) { reject("incompatible_price"); continue; }
    if (p.active === false || ["inactive", "removed", "sold", "rented"].includes(String(p.status)) || p.isAuction === true || p.isOccupied === true
      || (p.occupationType !== undefined && p.occupationType !== "free")) { reject("inactive_or_special_sale"); continue; }
    if (!inLocation(p, location)) { reject("unverified_or_different_location"); continue; }
    if (p.propertyType !== subject.propertyType || p.rooms !== subject.bedrooms || Math.abs(p.size / subject.areaM2! - 1) > 0.200000001) { reject("different_type_bedrooms_or_area"); continue; }
    const condition = conditionOf(p), amenities = listingFeatures(p);
    if ((subject.condition && condition && condition !== subject.condition) || (condition === "new_build" && subject.condition !== "new_build")) { reject("different_condition"); continue; }
    if (Object.entries(required).some(([key, value]) => value !== undefined && amenities[key as keyof typeof amenities] !== value)) { reject("unverified_or_different_required_feature"); continue; }
    const plot = number(p.plotArea);
    if (subject.plotAreaM2 && plot && Math.abs(plot / subject.plotAreaM2 - 1) > 0.5) { reject("materially_different_plot"); continue; }
    // ponytail: exact visible-address fingerprints only; cross-agent fuzzy dedup needs verified property identities.
    const fingerprint = p.showAddress === true && string(p.address) && string(p.thumbnail) && p.floor !== undefined
      ? JSON.stringify([normalizeText(p.address), p.floor, p.thumbnail, p.size, p.rooms, p.propertyType]) : undefined;
    if (fingerprint && fingerprints.has(fingerprint)) { reject("apparent_duplicate"); continue; }
    if (fingerprint) fingerprints.add(fingerprint);
    const differences: string[] = [];
    let preferenceMatches = 0;
    for (const [key, value] of Object.entries(subject.features ?? {})) {
      if (value === undefined) continue;
      const actual = amenities[key as keyof typeof amenities];
      if (actual === value) preferenceMatches++;
      else differences.push(`${key}: ${actual === undefined ? "unknown" : actual ? "present" : "absent"}`);
    }
    if (subject.condition && condition === subject.condition) preferenceMatches++;
    if (!condition || !subject.condition) differences.push("Condition comparison incomplete");
    if (subject.bathrooms !== undefined) {
      if (p.bathrooms === subject.bathrooms) preferenceMatches++;
      else differences.push(`Bathrooms: ${p.bathrooms ?? "unknown"} (subject ${subject.bathrooms})`);
    }
    if (["chalet", "countryHouse"].includes(p.propertyType)) differences.push(`Plot: ${plot ?? "unknown"} m² (subject ${subject.plotAreaM2 ?? "unknown"})`);
    candidates.push({ id: p.propertyCode, url, price: p.price, currency: "EUR", areaM2: p.size, areaBasis: "built", pricePerM2: p.price / p.size,
      bedrooms: p.rooms, bathrooms: p.bathrooms, propertyType: p.propertyType, location: [p.neighborhood, p.district, p.municipality].filter(v => typeof v === "string").join(", "),
      condition, features: amenities, plotAreaM2: plot, differences, preferenceMatches, areaDifference: Math.abs(p.size / subject.areaM2! - 1) });
  }
  candidates.sort((a, b) => b.preferenceMatches - a.preferenceMatches || a.areaDifference - b.areaDifference || a.id.localeCompare(b.id));
  return { candidates, excluded };
}

export function calculateMarketEstimate(comparables: Array<{ pricePerM2: number }>, area: number) {
  if (comparables.length < 3 || !Number.isFinite(area) || area <= 0 || comparables.some(p => !Number.isFinite(p.pricePerM2) || p.pricePerM2 <= 0)) return null;
  const values = comparables.map(p => p.pricePerM2).sort((a, b) => a - b);
  const percentile = (q: number) => { const i = (values.length - 1) * q, low = Math.floor(i); return values[low] + (values[Math.ceil(i)] - values[low]) * (i - low); };
  const round = (v: number) => v >= 5_000 ? Math.round(v / 5_000) * 5_000 : Math.round(v);
  return { central: round(percentile(0.5) * area), low: round(percentile(0.25) * area), high: round(percentile(0.75) * area),
    currency: "EUR", medianPricePerM2: Math.round(percentile(0.5)), sampleSize: values.length,
    method: "Median asking €/built m² × subject built area. Range: sample 25th–75th percentiles, rounded to €5,000; not a confidence interval.",
    thinSample: values.length < 5, wideDispersion: percentile(0.75) / percentile(0.25) > 1.3 };
}

export async function researchPropertyMarket(raw: MarketResearchInput, signal?: AbortSignal) {
  const input = marketResearchSchema.parse(raw);
  const { subject, source, selfUrl } = await resolveSubject(input, signal);
  const validation = subjectSchema.safeParse(subject);
  const missing = (["location", "propertyType", "bedrooms", "areaM2", "areaBasis"] as const).filter(k => subject[k] === undefined);
  if (!validation.success || missing.length || subject.areaBasis !== "built") return { state: "needs_input", subject, source, missing,
    message: "Provide location, residential subtype, bedrooms and verified built area in m². Usable/living and unverified CRM total areas cannot be substituted for built area." };
  const data = await idealistaGet("/auto-complete", { country: "pt", location_name: subject.location!.split(",")[0].trim(), property_type: "homes", search_type: "for_sale" }, signal);
  if (!Array.isArray(data.locations)) throw new Error("Idealista location response is missing locations.");
  const locations = data.locations.flatMap(v => { const p = locationSchema.safeParse(v); return p.success ? [p.data] : []; });
  const unique = [...new Map(locations.map(v => [v.locationId, v])).values()];
  const matches = unique.filter(v => input.locationId ? v.locationId === input.locationId : normalizeText(v.name) === normalizeText(subject.location));
  if (matches.length !== 1) return { state: "needs_location", subject, source, locations: unique.slice(0, 20),
    message: "Choose the intended locality from the returned names/IDs. Do not silently widen to another administrative area. If none match, clarify the location name." };
  const location = matches[0];
  const rows: unknown[] = [];
  let pagesFetched = 0, total = 0, totalPages = 0;
  const params = { country: "pt", location_ids: location.locationId, search_type: "for_sale", property_type: "homes", sort_order: "newest", result_count: 50, language: "en",
    min_size: subject.areaM2! * 0.8, max_size: subject.areaM2! * 1.2, min_rooms: subject.bedrooms!, filters: JSON.stringify({ [subject.propertyType!]: "true" }) };
  // ponytail: two pages give a bounded sample; increase coverage only when explicitly requested and costed.
  for (let page = 1; page <= 2; page++) {
    const response = await idealistaGet("/property-search", { ...params, page }, signal);
    // Live searches use query/listings; the published examples used filters/elementList.
    const filters = record(response.query ?? response.filters);
    if (filters.country !== "pt" || filters.search_type !== "for_sale" || filters.property_type !== "homes" || filters.location_ids !== location.locationId) throw new Error("Idealista search did not confirm the requested country, operation, property class and locality.");
    const pagination = z.object({ elementList: z.array(z.unknown()).max(50), total: z.number().int().nonnegative(), totalPages: z.number().int().nonnegative(), currentPage: z.number().int().optional(), actualPage: z.number().int().optional() }).safeParse({ ...response, elementList: response.listings ?? response.elementList });
    if (!pagination.success || (pagination.data.currentPage ?? pagination.data.actualPage) !== page) throw new Error("Idealista search returned invalid pagination or listing data.");
    total = pagination.data.total; totalPages = pagination.data.totalPages; pagesFetched++;
    rows.push(...pagination.data.elementList);
    if (!pagination.data.elementList.length || page >= totalPages) break;
  }
  const { candidates, excluded } = assessComparables(rows, subject, location, input.requiredFeatures, selfUrl);
  const used = candidates.slice(0, 10);
  const estimate = calculateMarketEstimate(used, subject.areaM2!);
  return { state: estimate ? "estimated" : "insufficient_data", subject, source, location, estimate, comparables: used,
    coverage: { source: "Idealista via Happy Endpoint / RapidAPI", fetchedAt: new Date().toISOString(), pagesFetched, fetched: rows.length, eligible: candidates.length, used: estimate ? used.length : 0,
      totalReported: total, truncated: pagesFetched < totalPages || rows.length < total, filters: params, excluded },
    limitations: ["Advertised asking prices, not completed-sale values or a formal valuation.", "Built area only; no automatic adjustment for condition, amenities or land.",
      "Bounded recent-listing sample; different advertisements for the same home may remain. Availability and unreported special sale conditions are unverified.",
      ...(!selfUrl ? ["Without an Idealista subject URL, advertisements of the subject home cannot always be identified and excluded."] : []),
      ...(estimate?.thinSample ? ["Thin sample: only three or four comparables."] : []), ...(estimate?.wideDispersion ? ["Comparable prices have wide dispersion."] : []),
      ...(estimate && estimate.low === estimate.high ? ["Identical rounded endpoints do not establish certainty."] : [])],
    guidance: estimate ? "Show the central estimate and range, sample count, date and 3–5 returned links with price, built m², €/m², bedrooms, locality and differences. Preserve the computed values."
      : `Search completed with ${rows.length} listings and ${candidates.length} verified comparables; at least 3 are required for a price estimate. Show available links and explain the sample shortfall; suggest an explicitly agreed broader locality or corrected subject facts, without automatically repeating the search.` };
}
