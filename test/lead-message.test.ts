import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactLeadMessageText,
  isVerboseLeadListing,
} from "../web/app/lead-message.js";
import type { LeadListView } from "../src/gateway/crm-ui-types.js";

const leadList: LeadListView = {
  id: "lead-list-test",
  leads: [],
  totalRecords: 6_389,
  returnedRecords: 20,
  truncated: true,
};

describe("compact lead message text", () => {
  it("replaces a long numbered lead dump with a structured-result summary", () => {
    const message = [
      "Here are the 20 latest leads (of 6,389 total):",
      "1. Danilo Dias — Ref 22584 | Recebido",
      "2. Gabriela Martinovic — Ref 21752 | Recebido",
      "3. Rita Calheiros — Ref 21855 | Sent to Broker",
      "4. Andre — Ref 22603 | Sent to Broker",
    ].join("\n");

    assert.equal(isVerboseLeadListing(message), true);
    assert.equal(
      compactLeadMessageText(message, leadList),
      "I found 20 leads out of 6,389 total. Select a lead below to view its details.",
    );
  });

  it("detects numbered rows even when the model runs them together", () => {
    assert.equal(
      isVerboseLeadListing(
        "Aug 13 7. Joao Alves — Ref 22576 8. Joao Alves — Website 9. Juliana Pereira — Ref 21092",
      ),
      true,
    );
  });

  it("keeps a concise summary or ordinary analysis unchanged", () => {
    const summary = "I found 20 of 6,389 leads, newest first.";
    const analysis =
      "The newest leads are concentrated in Lisbon, while broker assignments remain evenly distributed.";

    assert.equal(compactLeadMessageText(summary, leadList), summary);
    assert.equal(compactLeadMessageText(analysis, leadList), analysis);
  });

  it("keeps a numbered follow-up audit unchanged", () => {
    const analysis = [
      "**Overdue broker follow-ups**",
      "1. Ana Belchior — a requested viewing was not confirmed.",
      "2. Ricardo Rios — the client leaves tomorrow.",
      "3. Sandra Garrett — requested documents remain unanswered.",
      "Total: 3 overdue follow-ups across 3 brokers.",
    ].join("\n");

    assert.equal(isVerboseLeadListing(analysis), true);
    assert.equal(compactLeadMessageText(analysis, leadList), analysis);
  });
});
