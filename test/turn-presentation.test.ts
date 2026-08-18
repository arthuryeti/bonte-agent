import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LeadListView } from "../src/gateway/crm-ui-types.js";
import {
  persistedAssistantMessageForTurn,
  selectRelevantDataParts,
  temporaryStatusPartForEvent,
} from "../web/app/api/chat/turn-presentation.js";

function leadList(
  id: string,
  lead: {
    id: string;
    title: string;
    agent: string;
    reference: string;
  },
): LeadListView {
  return {
    id,
    leads: [{
      id: lead.id,
      title: lead.title,
      contact: { name: lead.title },
      agents: [{ name: lead.agent }],
      properties: [{ reference: lead.reference }],
      events: [],
      agentCount: 1,
      propertyCount: 1,
      eventCount: 0,
    }],
    totalRecords: 1,
    returnedRecords: 1,
    truncated: false,
    generatedAt: "2026-08-18T09:00:00.000Z",
  };
}

describe("completion-gated turn presentation", () => {
  it("exposes working states without exposing partial text or result cards", () => {
    const workingId = "working-turn-1";
    const specialist = temporaryStatusPartForEvent({
      type: "tool.start",
      payload: { run_id: "task-1", tool_name: "task" },
    }, workingId);
    const partialText = temporaryStatusPartForEvent({
      type: "message.delta",
      payload: { delta: "partial answer" },
    }, workingId);
    const leadResult = temporaryStatusPartForEvent({
      type: "lead.list.available",
      payload: { id: "lead-list-1", data: {} },
    }, workingId);

    assert.deepEqual(specialist, {
      type: "data-tool-status",
      id: workingId,
      data: { status: "running", label: "Specialist agent is working…" },
    });
    assert.equal(partialText, undefined);
    assert.deepEqual(leadResult, {
      type: "data-tool-status",
      id: workingId,
      data: { status: "running", label: "Analyzing lead data…" },
    });
  });

  it("selects the exact persisted final assistant message", () => {
    const final = {
      role: "assistant" as const,
      content: "Complete final response",
      platform_message_id: "assistant:turn-2",
    };
    const messages = [
      { role: "assistant" as const, content: "Older response", platform_message_id: "assistant:turn-1" },
      { role: "user" as const, content: "Question" },
      final,
    ];

    assert.equal(persistedAssistantMessageForTurn(messages, "turn-2"), final);
  });

  it("keeps only the result card most relevant to the final answer", () => {
    const current = leadList("current", {
      id: "lead-current",
      title: "Ana Belchior",
      agent: "Ricardo Rios",
      reference: "20882",
    });
    const stale = leadList("stale", {
      id: "lead-stale",
      title: "Negócio perdido!",
      agent: "Old Broker",
      reference: "0001",
    });
    const parts = [
      { type: "lead-list", id: current.id, data: current },
      { type: "lead-list", id: stale.id, data: stale },
    ];

    assert.deepEqual(
      selectRelevantDataParts(
        parts,
        "Ana Belchior is waiting for Ricardo Rios on property 20882.",
      ).map((part) => part.id),
      ["current"],
    );
  });

  it("falls back to the most recent result when the final text names no records", () => {
    const first = leadList("first", {
      id: "lead-1",
      title: "First Lead",
      agent: "First Broker",
      reference: "1001",
    });
    const latest = leadList("latest", {
      id: "lead-2",
      title: "Latest Lead",
      agent: "Latest Broker",
      reference: "1002",
    });

    assert.deepEqual(
      selectRelevantDataParts([
        { type: "lead-list", id: first.id, data: first },
        { type: "lead-list", id: latest.id, data: latest },
      ], "I found two CRM result sets.").map((part) => part.id),
      ["latest"],
    );
  });
});
