import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TurnDeliveryLedger } from "../src/gateway/turn-delivery-ledger.js";

const ref = { chatId: "chat-1", messageId: "message-1" };

describe("Hermes-style turn delivery reconciliation", () => {
  it("does not mistake a delivered tool preamble for the final answer", () => {
    const ledger = new TurnDeliveryLedger();
    ledger.recordStreamDelta("preamble", "I’ll check the CRM now.");
    ledger.recordStreamDelivery(ledger.streamText, ref);

    assert.equal(
      ledger.deliveredFinalMatches("Here are the latest leads."),
      false,
    );
  });

  it("recognizes an exact final segment inside a delivered streamed turn", () => {
    const ledger = new TurnDeliveryLedger();
    ledger.recordStreamDelta("preamble", "I’ll check the CRM now. ");
    ledger.recordStreamDelta("answer", "Here are the latest leads.");
    ledger.recordStreamDelivery(ledger.streamText, ref);

    assert.equal(
      ledger.deliveredFinalMatches("Here are the latest leads."),
      true,
    );
  });

  it("requires a corrective final delivery after a partial preview", () => {
    const ledger = new TurnDeliveryLedger();
    ledger.recordStreamDelta("answer", "Here are the latest ");
    ledger.recordStreamDelivery(ledger.streamText, ref);

    assert.equal(
      ledger.deliveredFinalMatches("Here are the latest leads."),
      false,
    );

    ledger.recordFinalDelivery("Here are the latest leads.", ref);
    assert.equal(
      ledger.deliveredFinalMatches("Here are the latest leads."),
      true,
    );
  });
});
