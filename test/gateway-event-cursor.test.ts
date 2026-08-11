import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GatewayEventCursor,
  type OrderedGatewayEvent,
} from "../src/gateway/web-event-cursor.js";

function event(
  eventId: string,
  sequence: number,
  turnId = "turn-1"
): OrderedGatewayEvent {
  return {
    event_id: eventId,
    sequence,
    session_id: "session-1",
    turn_id: turnId,
  };
}

describe("browser gateway event ordering", () => {
  it("rejects replayed and out-of-order turn events", () => {
    const cursor = new GatewayEventCursor();

    assert.equal(cursor.accept(event("turn-1:1", 1)), true);
    assert.equal(cursor.accept(event("turn-1:1", 1)), false);
    assert.equal(cursor.accept(event("different-id", 1)), false);
    assert.equal(cursor.accept(event("turn-1:2", 2)), true);
    assert.equal(cursor.accept(event("turn-2:1", 1, "turn-2")), true);
  });
});
