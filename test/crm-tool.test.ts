import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  callCrmApiTool,
  resolveAutoPagination,
  shapeLeadListResult,
  shapePropertyListResult,
} from "../src/tools/crm.js";
import {
  extractCrmToolError,
  normalizeLeadListToolOutput,
  normalizePropertyListToolOutput,
  normalizePropertyView,
} from "../src/gateway/crm-ui.js";
import { propertySummary } from "../src/workflows/crm-properties.js";
describe("CRM lead result shaping", () => {
  it("returns the newest 20 leads by default with result metadata", () => {
    const opportunities = Array.from({ length: 25 }, (_, index) => ({
      Id: String(index + 1),
      CreateDate: `2026-07-${String(index + 1).padStart(2, "0")}T09:00:00.000`,
    }));

    const result = shapeLeadListResult({ Opportunities: opportunities }) as {
      Opportunities: Array<{ Id: string }>;
      _result: Record<string, unknown>;
    };

    assert.equal(result.Opportunities.length, 20);
    assert.equal(result.Opportunities[0]?.Id, "25");
    assert.equal(result.Opportunities.at(-1)?.Id, "6");
    assert.deepEqual(result._result, {
      totalRecords: 25,
      returnedRecords: 20,
      limit: 20,
      sortBy: "CreateDate",
      sortDirection: "desc",
      detail: "summary",
      truncated: true,
    });
  });

  it("supports a bounded oldest-first LastUpdate result", () => {
    const result = shapeLeadListResult(
      {
        Success: { Code: "OK" },
        Opportunities: [
          { Id: "missing" },
          { Id: "new", LastUpdate: "2026-07-31T12:00:00.000" },
          { Id: "old", LastUpdate: "2026-07-01T12:00:00.000" },
        ],
      },
      {
        resultLimit: 2,
        resultSortBy: "LastUpdate",
        resultSortDirection: "asc",
      }
    ) as {
      Success: { Code: string };
      Opportunities: Array<{ Id: string }>;
      _result: Record<string, unknown>;
    };

    assert.deepEqual(
      result.Opportunities.map(({ Id }) => Id),
      ["old", "new"]
    );
    assert.equal(result.Success.Code, "OK");
    assert.deepEqual(result._result, {
      totalRecords: 3,
      returnedRecords: 2,
      limit: 2,
      sortBy: "LastUpdate",
      sortDirection: "asc",
      detail: "summary",
      truncated: true,
    });
  });

  it("compacts nested lead history while retaining useful contact context", () => {
    const result = shapeLeadListResult({
      Opportunities: [
        {
          Id: "lead-1",
          Title: "Viewing request",
          CreateDate: "2026-08-03T10:00:00.000",
          Description: "A very large internal description",
          Agents: [{ AgentID: "agent-1", AgentName: "Alex", Secret: "omit" }],
          Properties: [
            {
              PropertyID: "property-1",
              Reference: "A444",
              Address: "Lisbon",
              Description: "omit",
            },
          ],
          Customer: {
            Name: "Customer",
            EmailAddress: "customer@example.com",
            IdentificationNumber: "omit",
          },
          Events: [
            {
              EventID: "old",
              Title: "First contact",
              StartDate: "2026-08-01T09:00:00.000",
              Description: "omit",
            },
            {
              EventID: "new",
              Title: "Viewing",
              StartDate: "2026-08-03T09:00:00.000",
              Description: "omit",
            },
          ],
        },
      ],
    }) as {
      Opportunities: Array<Record<string, unknown>>;
      _result: Record<string, unknown>;
    };

    const lead = result.Opportunities[0];
    assert.equal(lead.Description, undefined);
    assert.deepEqual(lead.Agents, [
      { AgentID: "agent-1", AgentName: "Alex" },
    ]);
    assert.deepEqual(lead.Properties, [
      { PropertyID: "property-1", Reference: "A444", Address: "Lisbon" },
    ]);
    assert.deepEqual(lead.Customer, {
      Name: "Customer",
      EmailAddress: "customer@example.com",
    });
    assert.deepEqual(lead.Events, [
      {
        EventID: "new",
        Title: "Viewing",
        StartDate: "2026-08-03T09:00:00.000",
      },
      {
        EventID: "old",
        Title: "First contact",
        StartDate: "2026-08-01T09:00:00.000",
      },
    ]);
    assert.equal(lead.EventCount, 2);
    assert.equal(result._result.detail, "summary");
  });

  it("retains complete lead records when full detail is explicitly requested", () => {
    const opportunity = {
      Id: "lead-1",
      CreateDate: "2026-08-03T10:00:00.000",
      Description: "Keep this",
      Events: [{ Description: "Keep this too" }],
    };

    const result = shapeLeadListResult(
      { Opportunities: [opportunity] },
      { resultDetail: "full" }
    ) as {
      Opportunities: Array<Record<string, unknown>>;
      _result: Record<string, unknown>;
    };

    assert.deepEqual(result.Opportunities, [opportunity]);
    assert.equal(result._result.detail, "full");
  });

  it("leaves non-lead-shaped responses unchanged", () => {
    const response = { Errors: [{ Message: "Unavailable" }] };
    assert.equal(shapeLeadListResult(response), response);
  });
});

describe("CRM property result shaping", () => {
  it("defaults property searches to manual pagination", () => {
    assert.equal(
      resolveAutoPagination("/api/Property/ListProperties", undefined),
      false
    );
    assert.equal(
      resolveAutoPagination("/api/Property/ListProperties", true),
      true
    );
    assert.equal(resolveAutoPagination("/api/Agency/GetAgencies", undefined), true);
  });

  it("returns compact property previews with the full matching count", () => {
    const properties = Array.from({ length: 25 }, (_, index) => ({
      propertyId: index + 1,
      reference: `LX-${index + 1}`,
      bedrooms: 2,
      price: 400_000 + index,
      locale: [{
        language: "en",
        title: `Lisbon apartment ${index + 1}`,
        description: "x".repeat(2_000),
      }],
      location: { cityName: "Lisbon", address: `Street ${index + 1}` },
      photos: Array.from({ length: 10 }, (_, photoIndex) => ({
        Url: `https://images.example.com/${index + 1}-${photoIndex}.jpg`,
        SortOrder: photoIndex,
      })),
      files: [{ Url: "https://example.com/large-brochure.pdf" }],
    }));

    const result = shapePropertyListResult(
      { PropertyList: properties, Count: 184 },
      { resultLimit: 20 }
    ) as {
      PropertyList: Array<Record<string, unknown>>;
      _pagination: Record<string, unknown>;
    };

    assert.equal(result.PropertyList.length, 20);
    assert.deepEqual(result.PropertyList[0]?.photos, [{
      Url: "https://images.example.com/1-0.jpg",
      SortOrder: 0,
    }]);
    assert.equal(
      ((result.PropertyList[0]?.locale as Array<Record<string, unknown>>)[0]
        ?.description as string).length,
      600
    );
    assert.deepEqual(result._pagination, {
      autoPaginated: false,
      returnedRecords: 20,
      totalRecords: 184,
      detail: "summary",
      truncated: true,
    });
  });

  it("requests one bounded page for a Lisbon two-bedroom search", async () => {
    const originalFetch = globalThis.fetch;
    const originalBaseUrl = process.env.CRM_BASE_URL;
    let requestBody: Record<string, unknown> | undefined;
    let requestCount = 0;
    process.env.CRM_BASE_URL = "https://crm.example.test";
    globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        PropertyList: [{
          propertyId: 42,
          reference: "LX-42",
          bedrooms: 2,
          files: [{ Url: "https://example.test/large.pdf" }],
        }],
        Count: 184,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const output = await callCrmApiTool.invoke({
        endpoint: "/api/Property/ListProperties",
        method: "POST",
        filters: {
          FreeText: "Lisbon",
          MinBedrooms: 2,
          MaxBedrooms: 2,
        },
      });
      const parsed = JSON.parse(String(output)) as {
        PropertyList: Array<Record<string, unknown>>;
        _pagination: Record<string, unknown>;
      };

      assert.equal(requestCount, 1);
      assert.deepEqual(requestBody, {
        SequenceNmbr: 1,
        MaxResponses: 20,
        FreeText: "Lisbon",
        MinBedrooms: 2,
        MaxBedrooms: 2,
      });
      assert.equal(parsed._pagination.totalRecords, 184);
      assert.equal(parsed._pagination.truncated, true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBaseUrl === undefined) delete process.env.CRM_BASE_URL;
      else process.env.CRM_BASE_URL = originalBaseUrl;
    }
  });
});

describe("CRM lead browser normalization", () => {
  it("recognizes handled CRM failures returned through tool-end", () => {
    assert.equal(
      extractCrmToolError(JSON.stringify({
        _error: true,
        message: "CRM API error: 403 Forbidden",
      })),
      "CRM API error: 403 Forbidden"
    );
    for (const failure of [{ ok: false, error: "Unavailable" }, { state: "error", message: "Unavailable" }, { success: false, message: "Unavailable" }]) {
      assert.equal(extractCrmToolError(failure), "Unavailable");
      assert.equal(extractCrmToolError({ content: [{ type: "text", text: JSON.stringify(failure) }] }), "Unavailable");
      assert.equal(normalizeLeadListToolOutput({ ...failure, leads: [{ Id: "stale" }] }), undefined);
    }
  });

  it("uses locally matched lead totals and bounds cards to actual normalized records", () => {
    const result = normalizeLeadListToolOutput({ ok: true, leads: [{ Id: "lead-1", Customer: { Name: "Buyer" } }], matchedRecords: 12, returnedRecords: 1, previewTruncated: true, coverage: { fetchedRecords: 6546 } });
    assert.equal(result?.leads[0].id, "lead-1");
    assert.equal(result?.totalRecords, 12);
    assert.equal(result?.returnedRecords, 1);
    assert.equal(result?.truncated, true);
  });

  it("exposes a compact, safe component payload", () => {
    const result = normalizeLeadListToolOutput(JSON.stringify({
      Opportunities: [
        {
          Id: "lead-42",
          Title: "Lisbon viewing",
          CurrentStatus: { Name: "In progress" },
          Url: "javascript:alert(1)",
          Customer: {
            Name: "Joana Silva",
            EmailAddress: "joana@example.com",
            PhoneNumber: "+351 912 345 678",
          },
          Agents: [{ AgentID: "agent-1", AgentName: "Marta" }],
          Properties: [{ PropertyID: "property-1", Reference: "LX-100" }],
          Events: [{ EventID: "event-1", Title: "Call back", StartDate: "2026-08-12T09:00:00Z" }],
        },
      ],
      _result: { totalRecords: 18, returnedRecords: 1, truncated: true },
    }));

    assert.ok(result);
    assert.equal(result.totalRecords, 18);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.leads[0], {
      id: "lead-42",
      title: "Lisbon viewing",
      status: "In progress",
      origin: undefined,
      outcome: undefined,
      outcomeDate: undefined,
      priority: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      salePrice: undefined,
      crmUrl: undefined,
      contact: {
        name: "Joana Silva",
        email: "joana@example.com",
        phone: "+351 912 345 678",
        language: undefined,
      },
      agents: [{ id: "agent-1", name: "Marta" }],
      properties: [{
        id: "property-1",
        reference: "LX-100",
        address: undefined,
        price: undefined,
        updatedAt: undefined,
      }],
      events: [{
        id: "event-1",
        type: undefined,
        title: "Call back",
        description: undefined,
        location: undefined,
        startsAt: "2026-08-12T09:00:00Z",
        endsAt: undefined,
      }],
      agentCount: 1,
      propertyCount: 1,
      eventCount: 1,
    });
  });
});

describe("CRM property browser normalization", () => {
  it("renders only exact workflow matches using verified match counts and summary fields", () => {
    const property = { propertyId: 42, reference: "A-42", type: "Villa", priceVisible: false, livingArea: 120, totalArea: 180, plotArea: 300, features: ["Pool"], published: true };
    const data = { matches: [{ status: "exact", property }], unverified: [{ status: "unverified", property: { ...property, propertyId: 43 } }], coverage: { complete: false, totalRecords: 900 }, exactMatchesInScannedRecords: 1 };
    const result = normalizePropertyListToolOutput({ ok: true, ...data });
    assert.equal(result?.properties.length, 1);
    assert.equal(result?.totalRecords, 1, "Server candidate totals are not verified-match totals");
    assert.equal(result?.truncated, true);
    assert.equal(result?.properties[0].priceVisible, false);
    assert.equal(result?.properties[0].livingArea, "120");
    assert.equal(result?.properties[0].visibleOnWebsite, true);
    assert.deepEqual(result?.properties[0].features, ["Pool"]);
    assert.equal(normalizePropertyListToolOutput({ briefId: "buyer-1", matches: data.matches, unverified: data.unverified, totalMatches: 5, coverage: { complete: true } })?.totalRecords, 5);
    assert.equal(normalizePropertyListToolOutput({ ok: true, property, propertyId: 42, reference: "A-42" })?.properties[0].reference, "A-42");
    assert.equal(normalizePropertyListToolOutput({ ok: true, property, propertyId: 43, reference: "A-42" }), undefined);
    assert.equal(normalizePropertyListToolOutput({ ok: true, matches: [{ status: "unverified", property }], exactMatchesInScannedRecords: 0 })?.properties.length, 0);
    assert.equal(normalizePropertyListToolOutput({ ok: false, error: "Failed", ...data }), undefined);
  });

  it("prefers English titles, drops javascript photos, and keeps list truncation honest", () => {
    const result = normalizePropertyListToolOutput(JSON.stringify({
      PropertyList: [{
        propertyId: 42,
        reference: "LX-100",
        typeLocale: "Apartment",
        locale: [
          { language: "pt", title: "Apartamento", short: "Descrição PT" },
          { language: "en", title: "City apartment", short: "Sunny apartment" },
        ],
        photos: [
          { Url: "javascript:alert(1)", SortOrder: 1 },
          { Url: "https://images.example.com/property.jpg", SortOrder: 2 },
        ],
      }],
      Count: 17,
      _pagination: { returnedRecords: 1, totalRecords: 17, truncated: true },
    }));
    assert.equal(result?.properties[0].title, "City apartment");
    assert.equal(result?.properties[0].photoUrl, "https://images.example.com/property.jpg");
    assert.equal(result?.truncated, true);
    assert.equal(result?.totalRecords, 17);
  });

  it("ignores non-property CRM responses", () => {
    assert.equal(
      normalizePropertyListToolOutput(JSON.stringify({ Opportunities: [] })),
      undefined,
    );
  });

  it("uses the real title or reference, never a manufactured name, and rejects non-https listing URLs", () => {
    const unnamed = normalizePropertyListToolOutput({
      ok: true,
      property: { propertyId: 42, reference: "A-42", type: "Villa", listingUrl: "https://cdn.example.test/listing" },
      propertyId: 42,
      reference: "A-42",
    });
    assert.equal(unnamed?.properties[0].title, "A-42");
    assert.equal(unnamed?.properties[0].listingUrl, "https://cdn.example.test/listing");
    assert.equal(
      normalizePropertyListToolOutput({
        ok: true,
        property: { propertyId: 42, reference: "A-42", listingUrl: "http://insecure.example/x" },
        propertyId: 42,
        reference: "A-42",
      })?.properties[0].listingUrl,
      undefined,
    );
    assert.equal(propertySummary({ propertyId: 101, reference: "22568", title: "Scalar actual title" }).title, "Scalar actual title");
    assert.equal(normalizePropertyView({ propertyId: 101, reference: "22568", title: "Scalar actual title" }, 0, false)?.title, "Scalar actual title");
  });

  it("uses the teaser in cards and the full description in detail when both exist", () => {
    const record = {
      propertyId: 1,
      reference: "A-1",
      locale: [{ language: "en", title: "Villa", short: "Teaser copy", description: "Full listing description" }],
    };
    assert.equal(normalizePropertyView(record, 0, true)?.description, "Teaser copy");
    assert.equal(normalizePropertyView(record, 0, false)?.description, "Full listing description");
  });
});

describe("CRM lead related names", () => {
  it("preserves related property titles when the CRM supplies them", () => {
    const result = normalizeLeadListToolOutput({
      leads: [{ Id: "lead-1", Properties: [{ PropertyID: "42", Reference: "LX-100", Title: "City loft" }] }],
    });
    assert.equal(result?.leads[0].properties[0].title, "City loft");
  });
});
