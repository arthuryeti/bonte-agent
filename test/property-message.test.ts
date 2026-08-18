import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactPropertyMessageText } from "../web/app/property-message.js";
import type { PropertyListView } from "../src/gateway/crm-ui-types.js";

const propertyList: PropertyListView = {
  id: "property-list-test",
  properties: [],
  totalRecords: 38,
  returnedRecords: 3,
  truncated: true,
  generatedAt: "2026-08-17T10:00:00.000Z",
};

describe("compact property message text", () => {
  it("replaces duplicated property tables with a selectable-card summary", () => {
    const message = [
      "Here are the matching properties:",
      "| Reference | Type | Price |",
      "| --- | --- | --- |",
      "| LX-100 | Apartment | €475,000 |",
      "| LX-101 | Villa | €900,000 |",
    ].join("\n");

    assert.equal(
      compactPropertyMessageText(message, propertyList),
      "I found 3 properties out of 38 total. Select a property below to view its details.",
    );
  });

  it("keeps concise property analysis unchanged", () => {
    const summary = "I found three matching properties, led by two apartments in Lisbon.";
    assert.equal(compactPropertyMessageText(summary, propertyList), summary);
  });

  it("keeps a numbered property comparison unchanged", () => {
    const analysis = [
      "**Property comparison**",
      "1. LX-100 offers the best price per square metre.",
      "2. LX-101 has the strongest rental potential.",
      "3. LX-102 is the best fit for immediate occupancy.",
    ].join("\n");

    assert.equal(compactPropertyMessageText(analysis, propertyList), analysis);
  });
});
