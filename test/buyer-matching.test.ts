import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { matchBuyer, getBuyerMatches, normalizeBuyerListing, prepareBuyerShortlist } from "../src/workflows/buyer-matching.js";
import { assessProperty, type BuyerBrief } from "../src/workflows/crm-properties.js";
import { normalizePropertyListToolOutput } from "../src/gateway/crm-ui.js";
import { MemoryWorkflowStore, setWorkflowStore } from "../src/workflows/store.js";
import { applyTestS3Env } from "./s3-harness.js";

const context = { workspaceId: "buyer-test", actorId: "buyer-test", conversationId: "buyer-test_chat" };
const location = { name: "Cascais", locationId: "0-EU-PT-11-05" };
const crm = (id = 1, overrides = {}) => ({ id, reference: `BON-${id}`, type: "Apartment", businessType: "Sale", price: 500_000,
  currency: "EUR", bedrooms: 3, active: true, sold: false, features_list_enum: ["Terrace"], location: { countryCode: "pt", cityName: "Cascais" }, ...overrides });
const listing = (id = 1, overrides = {}) => ({ propertyCode: String(id), url: `https://www.idealista.pt/imovel/${id}/`, country: "pt", operation: "sale", propertyType: "flat",
  price: 550_000, size: 120, rooms: 3, municipality: "Cascais", features: { hasTerrace: true }, ...overrides });
const brief: BuyerBrief = { mandatory: { cities: ["Cascais"], price: { max: 750_000 }, bedrooms: { min: 3 }, propertyTypes: ["Apartment"] }, preferred: { features: ["Terrace"] } };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
let store: MemoryWorkflowStore;
let originalFetch: typeof globalThis.fetch;
let originalEnv: NodeJS.ProcessEnv;
let calls: URL[];
beforeEach(() => {
  originalFetch = globalThis.fetch; originalEnv = { ...process.env }; calls = [];
  store = new MemoryWorkflowStore(); setWorkflowStore(store);
  process.env.RAPIDAPI_KEY = "synthetic-test-key";
  delete process.env.CRM_LISTING_URLS_PATH; delete process.env.CRM_LISTING_URLS_JSON;
});
afterEach(() => {
  globalThis.fetch = originalFetch; mock.restoreAll();
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});
async function save(value = brief, id = "brief-1", leadId = "lead-1") {
  await store.put(context.workspaceId, "buyer_brief", id, { name: "Test Buyer", email: "buyer@example.test", leadId, brief: value });
}
function provider(options: { crm?: unknown[]; rows?: unknown[] | ((page: number) => unknown[]); locations?: unknown[]; pages?: number; total?: number; failPage?: number; crmFail?: boolean } = {}) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname === "/api/Leads/List") return json({ Success: {}, Opportunities: [{ Id: "lead-1", Description: "Explicit requirements in notes", Customer: { Name: "Test Buyer", EmailAddress: "buyer@example.test" } }] });
    if (url.pathname === "/api/Property/ListProperties") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.FreeText, undefined, "city free text must not narrow away valid inventory");
      if (options.crmFail) return json({ error: "Unavailable" }, 503);
      const rows = options.crm ?? [crm()];
      return json({ Success: {}, Count: rows.length, PropertyList: rows });
    }
    assert.equal(url.hostname, "idealista17.p.rapidapi.com");
    assert.equal(new Headers(init?.headers).get("x-rapidapi-key"), "synthetic-test-key");
    if (url.pathname === "/auto-complete") return json({ success: true, data: { locations: options.locations ?? [location] } });
    if (url.pathname === "/property-details-by-url") {
      const id = new URL(url.searchParams.get("url")!).pathname.split("/")[2];
      return json({ success: true, data: { region: "pt", adId: id, property: { ...listing(Number(id)), adid: id, extendedPropertyType: "flat", price: 600_000,
        features: undefined, moreCharacteristics: { constructedArea: 120, usableArea: 100, roomNumber: 3, lift: true, swimmingPool: true } } } });
    }
    assert.equal(url.pathname, "/property-search");
    const page = Number(url.searchParams.get("page"));
    if (page === options.failPage) return json({ error: "Do not expose provider secrets" }, 429);
    const rows = typeof options.rows === "function" ? options.rows(page) : options.rows ?? [listing()];
    return json({ success: true, data: { query: Object.fromEntries(url.searchParams), listings: rows,
      total: options.total ?? rows.length, totalPages: options.pages ?? 1, currentPage: page } });
  };
}
async function search(input = {}) {
  const result = await matchBuyer(context, { briefId: "brief-1", ...input });
  assert.equal(result.state, "matched");
  assert.ok("buyerSearch" in result);
  return result as Extract<Awaited<ReturnType<typeof matchBuyer>>, { buyerSearch: unknown }>;
}

it("matches both sources, scopes identities, filters budget/location, and pages saved selections without provider calls", async () => {
  await save(); provider({ rows: [...Array.from({ length: 23 }, (_, i) => listing(i + 1)), listing(100, { price: 750_001 }), listing(101, { municipality: "Sintra" })] });
  const result = await search({ leadId: "lead-1" });
  assert.equal(result.buyerSearch.exactCount, 24); assert.equal(result.buyerSearch.unverifiedCount, 0);
  assert.equal(result.buyerSearch.pages, 2); assert.equal(result.matches.length, 20);
  assert.equal(result.coverage.complete, true);
  assert.ok(result.matches.some(m => m.property.id === "crm:1"));
  assert.ok(result.matches.some(m => m.property.id === "idealista:1"));
  const count = calls.length;
  const page = await getBuyerMatches(context, { runId: result.buyerSearch.runId, page: 2, selectedIds: ["crm:1", "idealista:1"] });
  assert.equal(calls.length, count); assert.equal(page.matches.length, 4); assert.deepEqual(page.buyerSearch.selectedIds, ["crm:1", "idealista:1"]);
  const view = normalizePropertyListToolOutput(result)!;
  assert.equal(view.buyerSearch?.runId, result.buyerSearch.runId);
  assert.equal(view.properties.find(p => p.id === "idealista:1")?.sourceLinks?.[0].url, listing().url);
  assert.equal(view.properties.find(p => p.id === "idealista:1")?.builtArea, "120");
  await assert.rejects(getBuyerMatches({ ...context, workspaceId: "other" }, { runId: result.buyerSearch.runId }), /not found/);
  await assert.rejects(getBuyerMatches({ ...context, actorId: "other" }, { runId: result.buyerSearch.runId }), /not found/);
  await assert.rejects(getBuyerMatches(context, { runId: result.buyerSearch.runId, selectedIds: ["crm:999"] }), /outside this search/);
});

it("requires one explicit lead-linked brief and preserves unknown mandatory features, currency and area", async () => {
  provider();
  assert.equal((await matchBuyer(context, { leadId: "lead-1" })).state, "needs_brief");
  assert.equal(calls.length, 1);
  await save({ mandatory: { ...brief.mandatory, features: ["Garage"], livingArea: { min: 90 } } });
  const result = await search();
  assert.equal(result.buyerSearch.exactCount, 0); assert.equal(result.buyerSearch.unverifiedCount, 2);
  const view = normalizePropertyListToolOutput(result)!;
  assert.equal(view.properties.length, 2); assert.equal(view.properties[0].matchStatus, "unverified");
  const p = normalizeBuyerListing(listing(1, { parkingSpace: { hasParkingSpace: true } }))!;
  assert.equal(assessProperty(p, { features: ["Garage"] }).status, "unverified");
  assert.equal(assessProperty(p, { features: ["ParkingSpace"] }).status, "exact");
  assert.equal(assessProperty(p, { livingArea: { min: 90 } }).status, "unverified");
  assert.equal(assessProperty(p, { builtArea: { min: 90 } }).status, "exact");
  assert.equal(normalizeBuyerListing(listing(1, { currency: "USD" })), undefined);
  assert.equal(normalizeBuyerListing(listing(1, { url: "https://evil.test/imovel/1/" })), undefined);
  await save(brief, "other-brief", "other-lead");
  await assert.rejects(matchBuyer(context, { leadId: "lead-1", briefId: "other-brief" }), /different lead/);
});

it("preserves results and truthful coverage on later-page errors, provider caps and ambiguous locations", async () => {
  await save();
  provider({ rows: Array.from({ length: 50 }, (_, i) => listing(i + 1)), total: 100, pages: 2, failPage: 2 });
  const result = await search();
  assert.equal(result.buyerSearch.exactCount, 51); assert.equal(result.coverage.complete, false);
  assert.match(result.buyerSearch.coverage[1].warnings.join(" "), /429/);
  assert.ok(!JSON.stringify(result).includes("synthetic-test-key"));
  provider({ total: 100, pages: 2 });
  const capped = await search({ maxPages: 1 });
  assert.match(capped.buyerSearch.coverage[1].warnings.join(" "), /limit/);
  provider({ locations: [{ ...location, name: "Cascais e Estoril, Cascais" }] });
  const ambiguous = await search();
  assert.equal(ambiguous.buyerSearch.exactCount, 1);
  assert.equal(ambiguous.buyerSearch.coverage[1].locations?.[0].name, "Cascais e Estoril, Cascais");
  assert.equal(calls.filter(c => c.pathname === "/property-search").length, 3);
});

it("uses confirmed location IDs, keeps market results if CRM fails, and rejects repeated pages", async () => {
  await save({ ...brief, idealistaLocations: [{ ...location, name: "Cascais e Estoril, Cascais" }] });
  provider({ crmFail: true });
  const result = await search();
  assert.equal(result.buyerSearch.exactCount, 1); assert.equal(result.coverage.complete, false);
  provider({ total: 500, pages: 10 });
  const repeated = await search();
  assert.equal(repeated.buyerSearch.exactCount, 2);
  assert.match(repeated.buyerSearch.coverage[1].warnings.join(" "), /repeated page/);
});

it("deduplicates verified URLs, flags likely duplicate ads without hiding them, and rejects unavailable listings", async () => {
  await save();
  process.env.CRM_LISTING_URLS_JSON = JSON.stringify([{ propertyId: 1, reference: "BON-1", url: listing().url, verifiedAt: new Date().toISOString() }]);
  const visible = { showAddress: true, address: "Rua Teste 10", floor: "2", thumbnail: "https://img.test/home.jpg" };
  provider({ rows: [listing(), listing(2, visible), listing(3, visible), listing(4, { active: false }), listing(5, { isOccupied: true })] });
  const result = await search();
  assert.equal(result.buyerSearch.exactCount, 3);
  assert.equal(result.matches.find(m => m.property.id === "crm:1")?.property.sourceLinks.length, 2);
  assert.ok(result.matches.find(m => m.property.id === "idealista:2")?.property.matchReasons.some(r => r.includes("Possible duplicate")));
});

it("uses verified concelho membership when the live municipality label names a parish", async () => {
  await save(); provider({ locations: [{ name: "Cascais, Lisboa", locationId: location.locationId, subTypeText: "Concelho" }],
    rows: [listing(1, { municipality: "Alcabideche", district: "Amoreira", locationId: `${location.locationId}-001-01` }),
      listing(2, { municipality: "Sintra", locationId: "0-EU-PT-11-11-01" })] });
  const result = await search();
  assert.equal(result.buyerSearch.exactCount, 2);
  assert.equal(result.matches.find(m => m.property.id === "idealista:1")?.property.location.cityName, "Cascais");
  assert.ok(!result.matches.some(m => m.property.id === "idealista:2"));
});

it("matches the reported Lisboa brief using the city, live CRM currency/country, and both T3 and T4 buckets", async () => {
  const city = { name: "Lisboa, Lisboa", locationId: "0-EU-PT-11-06", subTypeText: "Concelho" };
  const district = { name: "Lisboa", locationId: "0-EU-PT-11", subTypeText: "Distrito" };
  for (const idealistaLocations of [undefined, [{ name: district.name, locationId: district.locationId }]]) {
    await save({ mandatory: { cities: ["Lisboa"], countryCode: "pt", currency: "EUR", propertyTypes: ["Apartment"], businessTypes: ["Sale"], price: { max: 2_000_000 }, bedrooms: { min: 3, max: 4 } }, idealistaLocations });
    provider({ locations: [district, city], crm: [crm(1, { currency: "€", priceprefixhelper: "EUR", location: { Country: "Portugal", City: "Lisboa" } })],
      rows: [listing(1, { municipality: "Benfica", locationId: `${city.locationId}-008-08`, rooms: 3 }),
        listing(2, { municipality: "Arroios", locationId: `${city.locationId}-002-02`, rooms: 4 }),
        listing(3, { municipality: "Arroios", locationId: `${city.locationId}-002-02`, rooms: 5 }),
        listing(4, { municipality: "Alcabideche", locationId: "0-EU-PT-11-05-001", rooms: 3 })] });
    const result = await search();
    assert.deepEqual(new Set(result.matches.map(m => m.property.id)), new Set(["crm:1", "idealista:1", "idealista:2"]));
    assert.equal(result.coverage.complete, true);
    const request = calls.filter(c => c.pathname === "/property-search").at(-1)!;
    assert.equal(request.searchParams.get("location_ids"), city.locationId);
    assert.equal(request.searchParams.get("min_rooms"), null);
    assert.deepEqual(JSON.parse(request.searchParams.get("filters")!), { flat: "true", bedrooms: "3,4" });
    assert.match(result.buyerSearch.coverage[1].scope!, /Concelho/);
  }
});

it("continues beyond development-only pages and counts unique records instead of repeated rows", async () => {
  await save();
  provider({ pages: 3, total: 3, rows: page => [listing(page, page === 2 ? { url: "https://www.idealista.pt/empreendimento/2/" } : {})] });
  const result = await search();
  assert.deepEqual(new Set(result.matches.map(m => m.property.id)), new Set(["crm:1", "idealista:1", "idealista:3"]));
  assert.equal(result.buyerSearch.coverage[1].fetchedRecords, 3);
  assert.match(result.buyerSearch.coverage[1].warnings.join(" "), /1 Idealista records.*development/);
  assert.ok(!result.buyerSearch.coverage[1].warnings.some(w => w.includes("repeated page")));
  provider({ pages: 2, total: 2, rows: [listing()] });
  const repeated = await search();
  assert.equal(repeated.buyerSearch.coverage[1].fetchedRecords, 1);
  assert.equal(repeated.coverage.complete, false, "duplicate final pages cannot prove complete coverage");
});

it("splits searches above the provider paging limit without losing or duplicating price-boundary listings", async () => {
  await save(); provider({ crm: [] });
  const all = Array.from({ length: 2600 }, (_, i) => listing(i + 1, { price: i < 1300 ? 374_999 : i === 1300 ? 375_000 : i === 1301 ? 375_000.01 : 375_001 }));
  const fallback = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== "/property-search") return fallback(input, init);
    calls.push(url);
    const page = Number(url.searchParams.get("page")); assert.ok(page <= 50);
    const min = Number(url.searchParams.get("min_price") ?? 0), max = Number(url.searchParams.get("max_price"));
    const rows = all.filter(p => p.price >= min && p.price <= max);
    return json({ success: true, data: { query: Object.fromEntries(url.searchParams), listings: rows.slice((page - 1) * 50, page * 50),
      total: rows.length, totalPages: Math.ceil(rows.length / 50), currentPage: page } });
  };
  const result = await search();
  assert.equal(result.buyerSearch.exactCount, 2600);
  assert.equal(result.buyerSearch.coverage[1].fetchedRecords, 2600);
  assert.equal(result.buyerSearch.coverage[1].totalRecords, 2600);
  assert.equal(result.coverage.complete, true);
  const saved = (await store.get(context.workspaceId, "buyer_match", result.buyerSearch.runId))!.data as { matches: Array<{ property: { sourceId: string } }> };
  assert.equal(saved.matches.filter(m => m.property.sourceId === "1301").length, 1);
  assert.ok(saved.matches.some(m => m.property.sourceId === "1302"));
  const capped = await search({ maxPages: 1 });
  assert.equal(capped.buyerSearch.exactCount, 50);
  assert.equal(capped.coverage.complete, false);
});

it("does not call providers for incomplete briefs or cancelled searches", async () => {
  await save({ mandatory: {} }); provider();
  assert.equal((await matchBuyer(context, { briefId: "brief-1" })).state, "needs_brief"); assert.equal(calls.length, 0);
  await save();
  await assert.rejects(matchBuyer(context, { briefId: "brief-1" }, AbortSignal.abort()), /abort/i);
  assert.equal(calls.length, 0);
});

it("refreshes the selected properties, reports removals and price changes, and saves an escaped presentation and unsent draft", async () => {
  await save({ ...brief, mandatory: { ...brief.mandatory, features: ["Pool", "Lift"] } });
  provider({ rows: [listing(1, { hasLift: true, features: { hasSwimmingPool: true } })] });
  const result = await search();
  provider({ crm: [crm(1, { sold: true })] });
  applyTestS3Env();
  const uploaded = new Map<string, string>();
  mock.method(S3Client.prototype, "send", async (command: unknown) => {
    if (command instanceof PutObjectCommand) { uploaded.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array).toString()); return {}; }
    if (command instanceof DeleteObjectCommand) return {};
    assert.fail("Unexpected storage action");
  });
  const prepared = await prepareBuyerShortlist(context, { runId: result.buyerSearch.runId, selectedIds: ["crm:1", "idealista:1"] });
  assert.ok("sent" in prepared); assert.equal(prepared.sent, false);
  assert.match(prepared.warnings.join(" "), /no longer available/); assert.match(prepared.warnings.join(" "), /asking price changed/);
  assert.ok(!prepared.warnings.some(w => w.includes("requirements still need verification")), "live detail feature names preserve verified pool/lift requirements");
  assert.match(prepared.body, /600,000 EUR/); assert.ok(!prepared.body.includes("BON-1"));
  assert.equal((await store.list(context.workspaceId, "buyer_shortlist"))[0].data.leadId, "lead-1");
  const html = [...uploaded.values()].find(v => v.startsWith("<!doctype html>"))!;
  assert.match(html, /https:\/\/www.idealista.pt\/imovel\/1\//);
  assert.ok(!html.includes("<script"));
  assert.equal((await store.list(context.workspaceId, "email-draft")).length, 1);
});
