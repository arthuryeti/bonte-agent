import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shapeLeadListResult } from "../src/tools/crm.js";

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
