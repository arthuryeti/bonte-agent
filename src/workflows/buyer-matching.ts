import { randomUUID } from "node:crypto";
import { z } from "zod";
import { record, string, number, normalizeText, type CrmRecord } from "./crm-common.js";
import { assessProperty, buyerBriefSchema, matchProperties, propertySummary, resolveExactProperty, searchProperties, type BuyerBrief } from "./crm-properties.js";
import { fetchAllLeads } from "./crm-leads.js";
import { idealistaGet, idealistaListingUrl } from "./idealista-client.js";
import { getWorkflowStore } from "./store.js";
import type { WorkflowContext } from "./context.js";
import type { SavedBuyerBrief } from "../tools/workflow-tools.js";
import { saveEmailDraft } from "./documents.js";
import { attachmentSummary, deleteAttachment, saveGeneratedAttachment } from "./documents-attachments.js";

const identifier = z.string().trim().min(1).max(180);
export const buyerMatchSchema = z.object({
  briefId: identifier.optional(), leadId: identifier.optional(),
  maxPages: z.number().int().min(1).max(100).default(100),
}).refine(v => v.briefId || v.leadId, "Provide a saved buyer brief or lead ID.");
export const buyerPageSchema = z.object({ runId: z.string().uuid(), page: z.number().int().positive().default(1), selectedIds: z.array(identifier).max(20).optional() });
export const buyerShortlistSchema = z.object({ runId: z.string().uuid(), selectedIds: z.array(identifier).min(1).max(20), recipient: z.string().email().optional() });
type Coverage = { source: string; complete: boolean; fetchedRecords: number; totalRecords?: number; warnings: string[]; scope?: string; locations?: Array<{ name: string; locationId: string }> };
type Match = ReturnType<typeof matchProperties>["matches"][number];
interface BuyerRun {
  briefId: string; leadId?: string; name: string; email?: string; brief: BuyerBrief;
  actorId: string; conversationId: string; fetchedAt: string; maxPages: number;
  matches: Match[]; unverified: Match[]; excludedCount: number; coverage: Coverage[]; selectedIds: string[];
}
const safeUrl = (value: unknown) => {
  try { const url = new URL(String(value)); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};
const keyOf = (p: CrmRecord) => p.source === "idealista" ? `idealista:${p.sourceId}` : `crm:${p.propertyId ?? p.id}`;
const unavailable = (p: CrmRecord) => p.active === false || p.sold === true || ["inactive", "removed", "sold", "rented", "reserved"].includes(normalizeText(p.status));

/** Keep the original source identity; never manufacture a CRM ID for a market listing. */
export function normalizeBuyerListing(raw: unknown): CrmRecord | undefined {
  const p = record(raw), url = idealistaListingUrl(p.url);
  if (!url || String(p.propertyCode) !== url.split("/").at(-2) || p.country !== "pt" || p.operation !== "sale") return;
  const price = number(p.price), currency = record(record(p.priceInfo).price ?? p.priceInfo);
  if ((p.currency !== undefined && p.currency !== "EUR") || (currency.currencySuffix !== undefined && currency.currencySuffix !== "€")
    || (currency.amount !== undefined && number(currency.amount) !== price)) return;
  const type: Record<string, string> = { flat: "Apartment", penthouse: "Apartment", duplex: "DuplexApartment", studio: "Studio", chalet: "Chalet", countryHouse: "CountryHouse" };
  if (!type[String(p.propertyType)]) return;
  const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100 ? v : undefined;
  const area = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 10_000_000 ? v : undefined;
  const f = record(p.features), parking = record(p.parkingSpace);
  const features = Object.fromEntries(Object.entries({ Pool: f.hasSwimmingPool, Garden: f.hasGarden, Terrace: f.hasTerrace, Balcony: f.hasBalcony,
    Lift: p.hasLift, ParkingSpace: parking.hasParkingSpace, AirConditioning: f.hasAirConditioning }).filter(([, v]) => typeof v === "boolean"));
  // A parking space does not establish an enclosed garage. Unknown amenities stay unknown.
  return { id: `idealista:${p.propertyCode}`, source: "idealista", sourceId: String(p.propertyCode), reference: `Idealista ${p.propertyCode}`,
    title: string(p.title) ?? `${p.rooms ?? "?"} bedroom ${p.propertyType} in ${p.municipality ?? "Portugal"}`,
    type: type[String(p.propertyType)], businessType: "Sale", price: price && price > 0 ? price : undefined, currency: "EUR",
    bedrooms: count(p.rooms), bathrooms: count(p.bathrooms), built_area: area(p.size), plot_area: area(p.plotArea),
    location: { countryCode: "pt", cityName: string(p.municipality), localityName: string(p.district), neighborhood: string(p.neighborhood), locationId: string(p.locationId) },
    features, features_list_enum: Object.keys(features).filter(k => features[k] === true), listingUrl: url,
    photos: safeUrl(p.thumbnail) ? [{ url: safeUrl(p.thumbnail) }] : [],
    active: typeof p.active === "boolean" ? p.active : undefined,
    status: string(p.status), sold: p.sold === true || p.status === "sold" ? true : undefined,
    specialSale: p.isAuction === true || p.isOccupied === true || (p.occupationType !== undefined && p.occupationType !== "free"),
    sourceLinks: [{ source: "Idealista", url }],
    duplicateHint: p.showAddress === true && string(p.address) && p.floor !== undefined
      ? JSON.stringify([normalizeText(p.address), p.floor, p.municipality, p.size, p.rooms]) : undefined,
  };
}

function crmListing(p: CrmRecord): CrmRecord {
  const summary = propertySummary(p);
  return { ...p, source: "crm", listingUrl: summary.listingUrl,
    sourceLinks: summary.listingUrl ? [{ source: "CRM", url: summary.listingUrl }] : [] };
}

function assessBuyerProperties(properties: CrmRecord[], brief: BuyerBrief) {
  const eligible = properties.filter(p => !unavailable(p) && p.specialSale !== true);
  // A generic Idealista house can be a villa or townhouse; do not exclude or certify its subtype.
  const prepared = eligible.map(p => p.source === "idealista" && p.type === "Chalet" && brief.mandatory.propertyTypes?.some(t => ["Villa", "Townhouse", "SemiDetached", "VillaFloor"].includes(t)) && !brief.mandatory.propertyTypes.includes("Chalet") ? { ...p, type: undefined } : p);
  const matched = matchProperties(prepared, brief);
  return { ...matched, excludedCount: matched.excluded.length + properties.length - eligible.length };
}

/** Merge only verified identical URLs; fuzzy similarities must not hide inventory. */
export function deduplicateBuyerMatches(matches: Match[]): Match[] {
  const ids = new Set<string>(), urls = new Map<string, Match>();
  const result: Match[] = [];
  for (const match of [...matches].sort((a, b) => Number(b.property.source === "crm") - Number(a.property.source === "crm"))) {
    const id = keyOf(match.property); if (ids.has(id)) continue; ids.add(id);
    const url = idealistaListingUrl(match.property.listingUrl) ?? safeUrl(match.property.listingUrl);
    const previous = url ? urls.get(url) : undefined;
    if (previous) {
      previous.property = { ...previous.property, sourceLinks: [...new Map([...((previous.property.sourceLinks as CrmRecord[]) ?? []), ...((match.property.sourceLinks as CrmRecord[]) ?? [])].map(link => [`${link.source}:${link.url}`, link])).values()] };
      continue;
    }
    if (url) urls.set(url, match);
    result.push(match);
  }
  return result.sort((a, b) => b.score - a.score || keyOf(a.property).localeCompare(keyOf(b.property)));
}

async function searchIdealista(brief: BuyerBrief, maxPages: number, signal?: AbortSignal) {
  const c = brief.mandatory;
  const coverage: Coverage = { source: "Idealista", complete: false, fetchedRecords: 0, totalRecords: 0, warnings: [] };
  const properties: CrmRecord[] = [];
  if ((c.countryCode && c.countryCode !== "pt") || (c.currency && c.currency !== "EUR") || (c.businessTypes?.length && (c.businessTypes.length !== 1 || c.businessTypes[0] !== "Sale"))) {
    coverage.warnings.push("Idealista buyer matching currently supports Portuguese residential sales in EUR only."); return { properties, coverage };
  }
  const places = brief.idealistaLocations ?? (c.localities?.length ? c.localities.map(name => ({ name: c.cities?.length === 1 ? `${name}, ${c.cities[0]}` : name })) : c.cities?.map(name => ({ name }))) ?? [];
  if (!places.length) { coverage.warnings.push("Provide locality names for Idealista; CRM numeric location IDs cannot be reused."); return { properties, coverage }; }
  let pagesFetched = 0, allComplete = true, invalidRecords = 0;
  const ids = new Set<string>(), seenLocations = new Set<string>();
  try {
    for (const place of places) {
      signal?.throwIfAborted();
      const lookup = await idealistaGet("/auto-complete", { country: "pt", location_name: place.name.split(",")[0].trim(), property_type: "homes", search_type: "for_sale" }, signal);
      if (!Array.isArray(lookup.locations)) throw new Error("Idealista location response is missing locations.");
      const locations = lookup.locations.flatMap(raw => { const p = record(raw); return string(p.name) && /^0-EU-PT(?:-\d+)+$/.test(String(p.locationId)) ? [{ name: String(p.name), locationId: String(p.locationId), subTypeText: string(p.subTypeText) }] : []; });
      const unique = [...new Map(locations.map(p => [p.locationId, p])).values()];
      const explicitId = "locationId" in place ? place.locationId : undefined;
      let selected = unique.filter(p => explicitId ? p.locationId === explicitId : normalizeText(p.name) === normalizeText(place.name));
      const cities = unique.filter(p => p.subTypeText === "Concelho" && c.cities?.some(city => normalizeText(city) === normalizeText(place.name.split(",")[0])
        && normalizeText(city) === normalizeText(p.name.split(",")[0])));
      // A mandatory city takes precedence over a same-named district saved by the agent.
      // Explicit parishes/neighbourhoods remain narrower constraints.
      if ((!explicitId && cities.length) || (selected.length === 1 && selected[0].subTypeText === "Distrito" && cities.some(city => city.locationId.startsWith(`${selected[0].locationId}-`)))) selected = cities;
      if (selected.length !== 1) {
        allComplete = false; coverage.locations = [...(coverage.locations ?? []), ...unique];
        coverage.warnings.push(`Choose the intended Idealista locality for ${place.name}; this area was not searched.`); continue;
      }
      const location = selected[0]; if (seenLocations.has(location.locationId)) continue; seenLocations.add(location.locationId);
      coverage.scope = [coverage.scope, `${location.name} (${location.subTypeText ?? "location"}; ${location.locationId})`].filter(Boolean).join("; ");
      const filters: Record<string, string> = {};
      const subtypes: Record<string, string> = { Apartment: "flat", DuplexApartment: "duplex", Studio: "studio", Chalet: "chalet", Villa: "chalet", Townhouse: "chalet", SemiDetached: "chalet", VillaFloor: "chalet", CountryHouse: "countryHouse" };
      if (c.propertyTypes?.length && c.propertyTypes.every(type => subtypes[type])) for (const type of c.propertyTypes) filters[subtypes[type]] = "true";
      // Live Portugal searches interpret bedrooms as buckets: 0, 1, 2, 3, 4+.
      // min_rooms=3 returns T3 only. Include every applicable bucket and recheck locally.
      if (c.bedrooms?.min !== undefined || c.bedrooms?.max !== undefined) {
        const bedrooms = [0, 1, 2, 3, 4].filter(n => (n === 4 || n >= (c.bedrooms!.min ?? 0)) && n <= (c.bedrooms!.max ?? 4));
        if (bedrooms.length) filters.bedrooms = bedrooms.join(",");
      }
      const ranges = [{ min: c.price?.min, max: c.price?.max }];
      for (const [rangeIndex, range] of ranges.entries()) {
        let lastPage = 1, total = 0, split = false;
        const rangeIds = new Set<string>();
        for (let page = 1; page <= lastPage; page++) {
          if (pagesFetched >= maxPages) { allComplete = false; coverage.warnings.push(`Stopped at the ${maxPages}-page Idealista search limit. Refine the brief or explicitly increase maxPages (up to 100).`); break; }
          const response = await idealistaGet("/property-search", { country: "pt", location_ids: location.locationId, search_type: "for_sale", property_type: "homes", language: "en", sort_order: "newest", result_count: 50, page,
            ...(range.max !== undefined ? { max_price: range.max } : {}), ...(range.min !== undefined ? { min_price: range.min } : {}),
            ...(Object.keys(filters).length ? { filters: JSON.stringify(filters) } : {}) }, signal);
          const query = record(response.query ?? response.filters);
          if (query.country !== "pt" || query.search_type !== "for_sale" || query.property_type !== "homes" || query.location_ids !== location.locationId) throw new Error("Idealista returned a different search scope.");
          if (rangeIndex > 0 && ((range.min !== undefined && Number(query.minPrice ?? query.min_price) !== range.min) || (range.max !== undefined && Number(query.maxPrice ?? query.max_price) !== range.max))) throw new Error("Idealista did not confirm the requested price range; coverage is partial.");
          if ((response.currentPage ?? response.actualPage) !== page) throw new Error(`Idealista returned page ${response.currentPage ?? response.actualPage} instead of ${page}; coverage is partial.`);
          const parsed = z.object({ rows: z.array(z.unknown()).max(50), total: z.number().int().nonnegative(), totalPages: z.number().int().nonnegative(), page: z.literal(page) }).parse({ rows: response.listings ?? response.elementList, total: response.total, totalPages: response.totalPages, page: response.currentPage ?? response.actualPage });
          pagesFetched++; lastPage = parsed.totalPages;
          if (page === 1) {
            total = parsed.total;
            if (rangeIndex === 0) coverage.totalRecords! += total;
            const midpoint = Math.floor(((range.min ?? 0) + (range.max ?? 0)) / 2);
            // Live pagination wraps after page 50. Split inclusive price ranges, retaining
            // the boundary on both sides so fractional prices cannot fall through a gap.
            // ponytail: huge same-price groups remain partial; split by locality if encountered.
            if (lastPage > 50 && midpoint > (range.min ?? 0) && midpoint < range.max! && pagesFetched + 1 < maxPages) {
              ranges.push({ min: range.min, max: midpoint }, { min: midpoint, max: range.max }); split = true; break;
            }
          }
          let newRecords = 0;
          for (const raw of parsed.rows) {
            const id = string(record(raw).propertyCode) ?? idealistaListingUrl(record(raw).url);
            if (!id) { invalidRecords++; continue; }
            if (rangeIds.has(id)) continue; rangeIds.add(id); newRecords++;
            if (ids.has(id)) continue; ids.add(id); coverage.fetchedRecords++;
            const p = normalizeBuyerListing(raw);
            if (!p) { invalidRecords++; continue; }
            // Portugal search rows may call a parish "municipality". A verified descendant
            // location ID establishes membership in the requested concelho without guessing.
            const pLocation = record(p.location), areaId = string(pLocation.locationId);
            if (areaId === location.locationId || areaId?.startsWith(`${location.locationId}-`)) {
              const placeName = normalizeText(location.name.split(",")[0]);
              const city = location.subTypeText === "Concelho" ? c.cities?.find(v => normalizeText(v) === placeName) : undefined;
              const locality = c.localities?.find(v => normalizeText(v) === placeName);
              p.location = { ...pLocation, ...(city ? { cityName: city } : {}), ...(locality ? { localityName: locality } : {}),
                verifiedSearchArea: { name: location.name, locationId: location.locationId } };
            }
            properties.push(p);
          }
          if (page < lastPage && !newRecords) { allComplete = false; coverage.warnings.push("Idealista returned an empty or repeated page; search stopped with partial coverage."); break; }
        }
        if (!split && rangeIds.size < total) allComplete = false;
      }
    }
    // Every leaf range was exhausted: the deduplicated count supersedes overlapping
    // or capped provider totals, including adverts we cannot normalize as properties.
    if (allComplete) coverage.totalRecords = coverage.fetchedRecords;
    coverage.complete = allComplete && !invalidRecords;
  } catch (error) {
    signal?.throwIfAborted(); coverage.warnings.push(error instanceof Error ? error.message : "Idealista search failed.");
  }
  if (invalidRecords) coverage.warnings.push(`${invalidRecords} Idealista records could not be verified as individual property listings (including development adverts); omitted from matches.`);
  if (!coverage.complete && !coverage.warnings.length) coverage.warnings.push("Some Idealista records were missing or could not be validated.");
  coverage.warnings = [...new Set(coverage.warnings)];
  return { properties, coverage };
}

async function runRecord(context: WorkflowContext, runId: string) {
  const row = await getWorkflowStore().get<BuyerRun>(context.workspaceId, "buyer_match", runId);
  if (!row || row.data.actorId !== context.actorId) throw new Error("Buyer matching result not found.");
  return row;
}

export async function getBuyerMatches(context: WorkflowContext, raw: z.input<typeof buyerPageSchema>) {
  const input = buyerPageSchema.parse(raw), row = await runRecord(context, input.runId), run = row.data;
  const all = [...run.matches, ...run.unverified];
  if (input.selectedIds) {
    const ids = [...new Set(input.selectedIds)];
    if (ids.some(id => !all.some(m => keyOf(m.property) === id))) throw new Error("Selection contains a property outside this search.");
    if (!await getWorkflowStore().compareAndSet(context.workspaceId, "buyer_match", row.id, row.version, { ...run, selectedIds: ids })) throw new Error("Selection changed. Reload the matching results and try again.");
    run.selectedIds = ids;
  }
  const pages = Math.max(1, Math.ceil(all.length / 20));
  if (input.page > pages) throw new Error(`This result has ${pages} pages.`);
  return { state: "matched", totalMatches: all.length, matches: all.slice((input.page - 1) * 20, input.page * 20).map(match => ({
    status: match.status, property: { ...propertySummary(match.property), id: keyOf(match.property), propertyId: keyOf(match.property),
      source: match.property.source, sourceId: String(match.property.sourceId ?? match.property.propertyId ?? match.property.id),
      builtArea: match.property.built_area, listingUrl: match.property.listingUrl, sourceLinks: match.property.sourceLinks,
      matchStatus: match.status, matchReasons: [...match.evidence, ...match.preferredEvidence].map(e => `${e.criterion.replace("feature:", "")}: ${e.status === "pass" ? "matched" : e.status === "fail" ? "not met" : "unknown"}`),
    } })),
    buyerSearch: { runId: row.id, briefId: run.briefId, leadId: run.leadId, name: run.name, page: input.page, pages, maxPages: run.maxPages,
      exactCount: run.matches.length, unverifiedCount: run.unverified.length, excludedCount: run.excludedCount,
      fetchedAt: run.fetchedAt, selectedIds: run.selectedIds, coverage: run.coverage },
    coverage: { complete: run.coverage.every(c => c.complete) },
    guidance: "Exact means verified buyer criteria, not confirmed availability. Availability and possible cross-agent duplicates need review. Needs-verification records have unknown mandatory facts. Browse saved pages with get_buyer_matches; never rerun a paid search just to paginate. Prepare only the user's selected properties with prepare_buyer_shortlist." };
}

export async function matchBuyer(context: WorkflowContext, raw: z.input<typeof buyerMatchSchema>, signal?: AbortSignal) {
  const input = buyerMatchSchema.parse(raw), store = getWorkflowStore();
  let briefId = input.briefId, lead: CrmRecord | undefined;
  if (input.leadId) {
    lead = (await fetchAllLeads()).leads.find(p => String(p.Id) === input.leadId);
    if (!lead) throw new Error("Lead not found in the CRM response.");
  }
  if (!briefId) {
    const briefs = (await store.list<SavedBuyerBrief>(context.workspaceId, "buyer_brief", 10_000)).filter(row => row.data.leadId === input.leadId);
    if (briefs.length !== 1) return { state: "needs_brief", lead, briefs: briefs.map(row => ({ id: row.id, name: row.data.name, brief: row.data.brief })),
      message: "Choose or save a buyer brief linked to this lead, using explicit requirements. Read the notes, ask only for missing or ambiguous requirements, and never infer a budget from an enquiry property." };
    briefId = briefs[0].id;
  }
  const saved = await store.get<SavedBuyerBrief>(context.workspaceId, "buyer_brief", briefId!);
  if (!saved?.data.brief) throw new Error("Save a structured buyer brief with mandatory/preferred criteria first.");
  if (input.leadId && saved.data.leadId !== input.leadId) throw new Error("The buyer brief belongs to a different lead.");
  if (saved.data.requirementsNeedClarification) throw new Error("This intake contains unresolved requirements. Review and save a complete structured buyer brief before matching.");
  const brief = buyerBriefSchema.parse(saved.data.brief);
  brief.mandatory.currency ??= "EUR";
  brief.mandatory.businessTypes ??= ["Sale"];
  const c = brief.mandatory;
  if (c.active === false || c.sold === true) throw new Error("Buyer matching searches available inventory. Remove conflicting sold/inactive requirements from the brief.");
  if (!c.price?.max || !(c.cities?.length || c.localities?.length || c.locationIds?.length || c.cityIds?.length || c.localityIds?.length)) return {
    state: "needs_brief", briefId, lead, brief, message: "Supply the buyer's explicit budget ceiling and locations before searching." };
  const sources = await Promise.allSettled([
    searchProperties({ criteria: { ...c, active: true, sold: false }, complete: true, pageSize: 100, maxPages: input.maxPages }, signal),
    searchIdealista(brief, input.maxPages, signal),
  ]);
  signal?.throwIfAborted();
  const coverage: Coverage[] = [], properties: CrmRecord[] = [];
  sources.forEach((source, i) => {
    if (source.status === "rejected") { coverage.push({ source: i ? "Idealista" : "CRM", complete: false, fetchedRecords: 0, warnings: [source.reason instanceof Error ? source.reason.message : "Source search failed."] }); return; }
    coverage.push(source.value.coverage);
    properties.push(...(i ? source.value.properties : source.value.properties.map(crmListing)));
  });
  const matching = assessBuyerProperties(properties, brief);
  const similar = new Map<string, Match[]>();
  for (const m of [...matching.matches, ...matching.unverified]) {
    const hint = string(m.property.duplicateHint);
    if (hint) similar.set(hint, [...(similar.get(hint) ?? []), m]);
  }
  for (const group of similar.values()) if (group.length > 1) for (const m of group) m.preferredEvidence.push({ criterion: "Possible duplicate advertisement; compare the listing links", status: "unknown", expected: "Distinct property", source: "Visible address, floor, area and bedrooms" });
  const exact = deduplicateBuyerMatches(matching.matches);
  const exactUrls = new Set(exact.map(m => idealistaListingUrl(m.property.listingUrl)).filter(Boolean));
  const unverified = deduplicateBuyerMatches(matching.unverified).filter(m => !exactUrls.has(idealistaListingUrl(m.property.listingUrl)));
  const run: BuyerRun = { briefId: briefId!, leadId: saved.data.leadId, name: saved.data.name, email: saved.data.email ?? string(record(lead?.Customer).EmailAddress),
    brief, actorId: context.actorId, conversationId: context.conversationId, fetchedAt: new Date().toISOString(), maxPages: input.maxPages,
    matches: exact, unverified, excludedCount: matching.excludedCount, coverage, selectedIds: [] };
  const runId = randomUUID(); await store.put(context.workspaceId, "buyer_match", runId, run);
  return getBuyerMatches(context, { runId });
}

async function refreshListing(p: CrmRecord, signal?: AbortSignal) {
  if (p.source !== "idealista") return crmListing((await resolveExactProperty({ propertyId: Number(p.propertyId ?? p.id), reference: String(p.reference) })).property);
  const url = idealistaListingUrl(p.listingUrl); if (!url) throw new Error("Invalid saved listing URL.");
  const response = await idealistaGet("/property-details-by-url", { url, language: "en" }, signal);
  const detail = record(response.property), more = record(detail.moreCharacteristics), id = String(p.sourceId);
  if (response.region !== "pt" || String(response.adId) !== id || String(detail.adid) !== id) throw new Error("The detail response has a different property identity.");
  const fresh = normalizeBuyerListing({ ...detail, propertyCode: id, url, propertyType: detail.extendedPropertyType ?? detail.propertyType,
    size: more.constructedArea, rooms: more.roomNumber, bathrooms: more.bathNumber, hasLift: more.lift ?? more.hasLift,
    status: detail.state === "inactive" ? "inactive" : more.status ?? detail.status,
    features: { ...record(detail.features), hasSwimmingPool: more.swimmingPool ?? record(detail.features).hasSwimmingPool,
      hasTerrace: more.terrace ?? record(detail.features).hasTerrace, hasGarden: more.garden ?? record(detail.features).hasGarden,
      hasBalcony: more.hasBalcony ?? record(detail.features).hasBalcony },
    thumbnail: record((Array.isArray(detail.multimedia) ? detail.multimedia : record(detail.multimedia).images as unknown[])?.[0]).url });
  if (!fresh) throw new Error("Listing details could not be verified.");
  // Detail pages often omit administrative location fields; keep the searched location with its timestamp.
  return { ...fresh, living_area: number(more.usableArea), location: string(record(fresh.location).cityName) ? fresh.location : p.location };
}

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export async function prepareBuyerShortlist(context: WorkflowContext, raw: z.input<typeof buyerShortlistSchema>, signal?: AbortSignal) {
  const input = buyerShortlistSchema.parse(raw);
  await getBuyerMatches(context, { runId: input.runId, selectedIds: input.selectedIds });
  const run = (await runRecord(context, input.runId)).data;
  const selected = [...run.matches, ...run.unverified].filter(m => input.selectedIds.includes(keyOf(m.property)));
  const warnings: string[] = [], refreshed: CrmRecord[] = [];
  // ponytail: at most 20 sequential detail lookups; bounded concurrency if shortlist latency warrants it.
  for (const match of selected) {
    signal?.throwIfAborted();
    try {
      const fresh = await refreshListing(match.property, signal);
      if (unavailable(fresh) || fresh.specialSale === true) { warnings.push(`${fresh.reference}: no longer available; omitted.`); continue; }
      const assessment = assessBuyerProperties([fresh], run.brief);
      if (assessment.excludedCount) { warnings.push(`${fresh.reference}: no longer satisfies the buyer's requirements; omitted.`); continue; }
      if (number(fresh.price) !== number(match.property.price)) warnings.push(`${fresh.reference}: asking price changed from ${match.property.price ?? "unknown"} to ${fresh.price ?? "unknown"}.`);
      if (assessment.unverified.length) warnings.push(`${fresh.reference}: some buyer requirements still need verification.`);
      refreshed.push(fresh);
    } catch (error) { signal?.throwIfAborted(); warnings.push(`${match.property.reference}: could not refresh; omitted. ${error instanceof Error ? error.message : ""}`); }
  }
  if (!refreshed.length) return { state: "needs_review", warnings, message: "None of the selected properties could be verified for the shortlist. No draft was generated." };
  const timestamp = new Date().toISOString();
  const descriptions = refreshed.map(p => {
    const summary = propertySummary(p);
    const price = p.price_visible === false ? "Price on request" : number(p.price) ? `${Number(p.price).toLocaleString("en-GB")} ${p.currency ?? "EUR"}` : "Price on request";
    const location = record(p.location);
    return { p, title: String(summary.title ?? p.reference), price, location: [location.localityName ?? location.Locality, location.cityName ?? location.City].filter(Boolean).join(", "),
      reasons: assessProperty(p, run.brief.preferred ?? {}).evidence.filter(e => e.status === "pass").map(e => e.criterion.replace("feature:", "")),
      unknowns: assessBuyerProperties([p], run.brief).unverified.flatMap(m => m.evidence.filter(e => e.status === "unknown").map(e => e.criterion.replace("feature:", ""))),
      url: safeUrl(p.listingUrl), photo: safeUrl(record((p.photos as unknown[] | undefined)?.[0]).url ?? record((p.photos as unknown[] | undefined)?.[0]).Url) };
  });
  const body = `Hello ${run.name},\n\nHere is your property shortlist:\n\n${descriptions.map((d, i) => `${i + 1}. ${d.title} (${d.p.reference})\n${d.price} · ${d.p.bedrooms ?? "?"} bedrooms · ${d.location}\n${d.reasons.length ? `Preferences matched: ${d.reasons.join(", ")}\n` : ""}${d.unknowns.length ? `Needs confirmation: ${d.unknowns.join(", ")}\n` : ""}${d.url ?? "Public listing link unavailable."}`).join("\n\n")}\n\nDetails checked ${timestamp.slice(0, 10)}. Availability and any missing requirements need confirmation with the listing agent.\n\nPlease let me know which properties you would like to explore.\n\nBonte Filipidis`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Your property shortlist</title><style>body{font:17px/1.5 system-ui;max-width:900px;margin:40px auto;padding:0 20px;color:#243830;background:#faf9f5}article{background:white;border:1px solid #ddd;border-radius:12px;margin:24px 0;padding:24px;break-inside:avoid}img{width:100%;max-height:360px;object-fit:cover;border-radius:8px}a{color:#245a48}small{color:#555}</style><h1>Your property shortlist</h1><p>Prepared for ${escapeHtml(run.name)}</p>${descriptions.map(d => `<article>${d.photo ? `<img src="${escapeHtml(d.photo)}" alt="${escapeHtml(d.title)}" loading="lazy">` : ""}<h2>${escapeHtml(d.title)}</h2><p><strong>${escapeHtml(d.price)}</strong> · ${escapeHtml(d.p.bedrooms ?? "?")} bedrooms · ${escapeHtml(d.location)}</p><p>${escapeHtml(d.p.reference)}</p>${d.reasons.length ? `<p>Preferences matched: ${escapeHtml(d.reasons.join(", "))}</p>` : ""}${d.unknowns.length ? `<p>Needs confirmation: ${escapeHtml(d.unknowns.join(", "))}</p>` : ""}${d.url ? `<a href="${escapeHtml(d.url)}" rel="noopener noreferrer">View listing</a>` : "<p>Public listing link unavailable.</p>"}</article>`).join("")}<small>Details checked ${escapeHtml(timestamp)}. Availability and missing requirements need confirmation with the listing agent. Bonte Filipidis.</small></html>`;
  const attachment = await saveGeneratedAttachment(context, { fileName: "Bonte-buyer-shortlist.html", mimeType: "text/html; charset=utf-8", bytes: Buffer.from(html) });
  let draft;
  try { draft = await saveEmailDraft(context, { recipient: input.recipient ?? run.email, subject: "Your property shortlist — Bonte Filipidis", body, attachmentIds: [attachment.id] }); }
  catch (error) { await deleteAttachment(context, attachment.id).catch(() => undefined); throw error; }
  await getWorkflowStore().put(context.workspaceId, "buyer_shortlist", draft.id, { leadId: run.leadId, briefId: run.briefId, runId: input.runId, selectedIds: run.selectedIds,
    properties: refreshed, warnings, draftId: draft.id, attachmentId: attachment.id, actorId: context.actorId, conversationId: context.conversationId, fetchedAt: timestamp });
  return { ...draft, shortlist: attachmentSummary(attachment), warnings, sent: false };
}
