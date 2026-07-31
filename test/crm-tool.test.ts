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
      truncated: true,
    });
  });

  it("leaves non-lead-shaped responses unchanged", () => {
    const response = { Errors: [{ Message: "Unavailable" }] };
    assert.equal(shapeLeadListResult(response), response);
  });
});
