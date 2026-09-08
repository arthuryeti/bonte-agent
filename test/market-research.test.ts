import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { assessComparables, calculateMarketEstimate, idealistaListingUrl, marketResearchStatus, researchPropertyMarket } from "../src/workflows/market-research.js";
import { researchPropertyMarketTool } from "../src/tools/workflow-tools.js";
import { runWithWorkflowContext } from "../src/workflows/context.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.RAPIDAPI_KEY;
afterEach(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.RAPIDAPI_KEY; else process.env.RAPIDAPI_KEY = originalKey; });

// Synthetic Portuguese facts in the published Happy Endpoint OpenAPI example envelopes.
// The examples document built `size`, `rooms`, priceInfo and the filters echo; these are not live listings.
const location = { name: "Cascais e Estoril, Cascais", locationId: "0-EU-PT-11-05-01", subTypeText: "Freguesia" };
const subject = { country: "pt" as const, location: location.name, propertyType: "flat" as const, bedrooms: 2, areaM2: 100, areaBasis: "built" as const, condition: "good" as const };
const listing = (id: number, price = 350_000, overrides = {}) => ({ propertyCode: String(id), url: `https://www.idealista.pt/imovel/${id}/`, price,
  priceInfo: { price: { amount: price, currencySuffix: "€" } }, size: 100, propertyType: "flat", operation: "sale", country: "pt", rooms: 2, bathrooms: 2,
  municipality: "Cascais", district: "Cascais e Estoril", status: "good", newDevelopment: false, hasLift: true,
  parkingSpace: { hasParkingSpace: true }, ...overrides });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const calls: URL[] = [];
function provider(rows = [listing(1, 300_000), listing(2), listing(3, 400_000)], options: { locations?: unknown[]; pages?: number; total?: number } = {}) {
  calls.length = 0;
  process.env.RAPIDAPI_KEY = "test-secret";
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url)); calls.push(u);
    assert.equal(u.hostname, "idealista17.p.rapidapi.com"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("x-rapidapi-key"), "test-secret");
    assert.equal(new Headers(init?.headers).get("x-rapidapi-host"), u.hostname);
    if (u.pathname === "/auto-complete") {
      assert.equal(u.searchParams.get("location_name"), subject.location.split(",")[0]);
      return json({ success: true, data: { locations: options.locations ?? [location] } });
    }
    assert.equal(u.pathname, "/property-search");
    const filters = Object.fromEntries(u.searchParams);
    assert.equal(filters.search_type, "for_sale"); assert.equal(filters.country, "pt"); assert.equal(filters.property_type, "homes");
    assert.equal(filters.min_size, "80"); assert.equal(filters.max_size, "120"); assert.equal(filters.min_rooms, "2");
    assert.deepEqual(JSON.parse(filters.filters), { flat: "true" });
    assert.equal(filters.sort_order, "newest"); assert.equal(filters.min_price, undefined); assert.equal(filters.max_price, undefined);
    return json({ success: true, data: { filters, elementList: rows, total: options.total ?? rows.length, totalPages: options.pages ?? 1, currentPage: Number(filters.page) } });
  };
}

it("calculates sample percentiles in code and returns verified links plus exact search coverage", async () => {
  provider();
  const result = await researchPropertyMarket({ subject });
  assert.equal(result.state, "estimated");
  if (!("estimate" in result)) assert.fail("missing estimate");
  assert.equal(result.estimate?.central, 350_000); assert.equal(result.estimate.low, 325_000); assert.equal(result.estimate.high, 375_000);
  assert.equal(result.estimate.medianPricePerM2, 3500); assert.equal(result.estimate.thinSample, true);
  assert.equal(result.comparables.length, 3); assert.equal(result.coverage.used, 3); assert.equal(result.coverage.truncated, false);
  assert.equal(calls.length, 2); assert.match(result.limitations.join(" "), /not completed-sale/);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
  assert.equal(calculateMarketEstimate([{ pricePerM2: 1 }, { pricePerM2: 2 }], 100), null);
  assert.equal(calculateMarketEstimate([{ pricePerM2: NaN }, { pricePerM2: 2 }, { pricePerM2: 3 }], 100), null);
  const even = calculateMarketEstimate([1000, 2000, 3000, 4000].map(pricePerM2 => ({ pricePerM2 })), 100);
  assert.equal(even?.central, 250_000); assert.equal(even.low, 175_000); assert.equal(even.high, 325_000);
});

it("requires verified built area, including when the user supplies usable area", async () => {
  globalThis.fetch = async () => assert.fail("must not fetch");
  assert.equal((await researchPropertyMarket({ subject: { ...subject, areaBasis: "usable" } })).state, "needs_input");
  const result = await researchPropertyMarket({ subject: { location: "Cascais" } });
  assert.equal(result.state, "needs_input");
  if ("missing" in result) assert.ok(result.missing.includes("areaBasis"));
  await assert.rejects(researchPropertyMarket({ subject: { ...subject, areaM2: 0 } }));
});

it("returns ambiguous locations for a choice and verifies any selected ID", async () => {
  const second = { ...location, locationId: "0-EU-PT-11-05-02" };
  provider(undefined, { locations: [location, second] });
  assert.equal((await researchPropertyMarket({ subject })).state, "needs_location"); assert.equal(calls.length, 1);
  assert.equal((await researchPropertyMarket({ subject, locationId: "0-EU-PT-99" })).state, "needs_location");
  assert.equal((await researchPropertyMarket({ subject, locationId: second.locationId })).state, "estimated");
  provider(undefined, { locations: [{ ...location, name: "Cascais" }] });
  assert.equal((await researchPropertyMarket({ subject })).state, "needs_location", "must not silently widen to municipality");
});

it("excludes duplicate, self, unsafe, invalid and nonmatching listings, preserving unknown evidence", () => {
  const bad = [listing(1), listing(2), listing(3, 10, { size: 0 }), listing(4, 10, { rooms: 3 }), listing(5, 10, { country: "es" }),
    listing(6, 10, { operation: "rent" }), listing(7, 10, { propertyType: "chalet" }), listing(8, 10, { currency: "USD" }),
    listing(9, 10, { district: "Other" }), listing(10, 10, { url: "https://evil.test/imovel/10/" }), listing(11, 10, { active: false }),
    listing(12, 10, { newDevelopment: true }), listing(13, 10, { status: "renew" }), listing(14, 10, { occupationType: "bareOwnership" }),
    listing(15, 10, { size: 121 }), listing(16, -10), listing(17, 10, { url: "https://www.idealista.pt/imovel/18/" })];
  const result = assessComparables([listing(1), ...bad, listing(20, 350_000, { status: undefined })], subject, location, {}, listing(2).url);
  assert.deepEqual(result.candidates.map(p => p.id), ["1", "20"]);
  assert.equal(result.excluded.duplicate, 1); assert.equal(result.excluded.subject_listing, 1);
  assert.ok(result.candidates[1].differences.includes("Condition comparison incomplete"));
  assert.equal(assessComparables([listing(1)], subject, location, { pool: true }).candidates.length, 0);
  assert.equal(assessComparables([listing(1)], subject, location, { parking: true, lift: true }).candidates.length, 1);
  assert.equal(idealistaListingUrl("https://idealista.pt/en/imovel/123/?utm_source=test"), "https://www.idealista.pt/imovel/123/");
  for (const url of ["https://idealista.pt.evil.test/imovel/1/", "http://idealista.pt/imovel/1/", "https://u:p@idealista.pt/imovel/1/", "https://idealista.pt:8443/imovel/1/", "https://idealista.pt/imovel/1/../../other"]) assert.equal(idealistaListingUrl(url), undefined);
});

it("reports insufficient data without a price or automatic widened search", async () => {
  provider([listing(1), listing(2)]);
  const result = await researchPropertyMarket({ subject });
  assert.equal(result.state, "insufficient_data");
  if (!("estimate" in result)) assert.fail("missing estimate state");
  assert.equal(result.estimate, null); assert.equal(result.comparables.length, 2); assert.equal(result.coverage.used, 0); assert.equal(calls.length, 2);
});

it("caps search at two pages, deduplicates repeats and exposes incomplete coverage", async () => {
  provider(Array.from({ length: 50 }, (_, i) => listing(i + 1)), { pages: 100, total: 5000 });
  const result = await researchPropertyMarket({ subject });
  if (!("estimate" in result)) assert.fail("missing estimate");
  assert.equal(calls.length, 3); assert.equal(result.coverage.fetched, 100); assert.equal(result.coverage.eligible, 50);
  assert.equal(result.coverage.used, 10); assert.equal(result.coverage.truncated, true); assert.equal(result.coverage.excluded.duplicate, 50);
});

it("ranks features before area closeness, not price, and excludes materially different plots", () => {
  const rows = [listing(1, 1_000_000, { hasLift: false }), listing(2, 300_000, { hasLift: true })];
  assert.deepEqual(assessComparables(rows, { ...subject, features: { lift: true } }, location).candidates.map(p => p.id), ["2", "1"]);
  const houses = [listing(1, 350_000, { propertyType: "chalet", plotArea: 1000 }), listing(2, 350_000, { propertyType: "chalet", plotArea: 400 })];
  assert.deepEqual(assessComparables(houses, { ...subject, propertyType: "chalet", plotAreaM2: 400 }, location).candidates.map(p => p.id), ["2"]);
});

it("resolves an Idealista subject through the fixed details endpoint and excludes its own listing", async () => {
  provider(); const search = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname !== "/property-details-by-url") return search(url, init);
    assert.equal(u.hostname, "idealista17.p.rapidapi.com"); assert.match(u.searchParams.get("url")!, /^https:\/\/www\.idealista\.pt\/imovel\/[12]\/$/);
    return json({ success: true, data: { region: "pt", adId: "1", property: { adid: "1", country: "pt", operation: "sale", extendedPropertyType: "flat", moreCharacteristics: { constructedArea: 100, roomNumber: 2 } } } });
  };
  const result = await researchPropertyMarket({ idealistaUrl: listing(1).url, subject: { location: subject.location } });
  assert.equal(result.state, "insufficient_data");
  if ("estimate" in result) assert.equal(result.coverage.excluded.subject_listing, 1);
  await assert.rejects(researchPropertyMarket({ idealistaUrl: "https://evil.test/imovel/1/", subject }), /valid HTTPS/);
  await assert.rejects(researchPropertyMarket({ idealistaUrl: listing(2).url, subject }), /requested Portuguese/);
});

it("reuses exact CRM identity while leaving ambiguous CRM area for user clarification", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.Reference, "B-42");
    return json({ Success: {}, Count: 1, PropertyList: [{ id: 42, reference: "B-42", type: "Apartment", businessType: "Sale", bedrooms: 2, total_area: 100, living_area: 85,
      location: { countryCode: "pt", localityName: "Cascais e Estoril", cityName: "Cascais" } }] });
  };
  const result = await researchPropertyMarket({ reference: "B-42" });
  assert.equal(result.state, "needs_input"); assert.equal(result.subject.areaM2, undefined); assert.equal(result.source.reference, "B-42");
  await assert.rejects(researchPropertyMarket({ reference: "B-42", propertyId: 43 }), /No exact property/);
});

it("handles absent credentials, HTTP/application failures and malformed provider responses without leaking secrets", async () => {
  delete process.env.RAPIDAPI_KEY;
  assert.equal(marketResearchStatus().configured, false);
  await assert.rejects(researchPropertyMarket({ subject }), /RAPIDAPI_KEY/);
  process.env.RAPIDAPI_KEY = "never-echo-this";
  for (const status of [401, 403, 429, 500]) {
    globalThis.fetch = async () => json({ message: "never-echo-this" }, status);
    await assert.rejects(researchPropertyMarket({ subject }), e => e instanceof Error && e.message.includes(String(status)) && !e.message.includes("never-echo-this"));
  }
  for (const body of [{ success: false, data: {} }, { success: true, data: [] }, { success: true, data: {} }]) {
    globalThis.fetch = async () => json(body); await assert.rejects(researchPropertyMarket({ subject }), /invalid response|missing locations/);
  }
  globalThis.fetch = async () => new Response("not json"); await assert.rejects(researchPropertyMarket({ subject }), /malformed JSON/);
  const controller = new AbortController(); controller.abort();
  globalThis.fetch = async (_url, init) => { assert.equal(init?.signal?.aborted, true); throw new Error("aborted"); };
  await assert.rejects(researchPropertyMarket({ subject }, controller.signal), /cancelled/);
});

it("rejects unconfirmed query echoes and repeated/invalid pagination", async () => {
  for (const invalid of [{ filters: { country: "es" } }, { currentPage: 2 }, { elementList: {} }]) {
    provider(); const fetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (new URL(String(url)).pathname === "/auto-complete") return response;
      const body = await response.json(); return json({ ...body, data: { ...body.data, ...invalid } });
    };
    await assert.rejects(researchPropertyMarket({ subject }), /did not confirm|invalid pagination/);
  }
});

it("requires authenticated workflow context and returns handled tool errors", async () => {
  provider();
  const unauthenticated = JSON.parse(String(await researchPropertyMarketTool.invoke({ subject })));
  assert.equal(unauthenticated.state, "error"); assert.equal(calls.length, 0);
  const output = await runWithWorkflowContext({ workspaceId: "test", actorId: "test", conversationId: "test" }, () => researchPropertyMarketTool.invoke({ subject }));
  assert.equal(JSON.parse(String(output)).state, "estimated");
});
