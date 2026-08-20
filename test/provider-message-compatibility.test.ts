import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { removeEmptyAssistantTextBlocks } from "../src/providers/message-compatibility.js";

describe("provider message compatibility", () => {
  it("removes empty streamed text blocks without losing tool calls", () => {
    const message = new AIMessage({
      content: [
        { type: "text", text: "" },
        {
          type: "tool_use",
          id: "tool-1",
          name: "read_file",
          input: { file_path: "/large_tool_results/result-1" },
        },
      ],
      tool_calls: [
        {
          id: "tool-1",
          name: "read_file",
          args: { file_path: "/large_tool_results/result-1" },
          type: "tool_call",
        },
      ],
    });

    const [sanitized] = removeEmptyAssistantTextBlocks([message]);

    assert.ok(AIMessage.isInstance(sanitized));
    assert.deepEqual(sanitized.content, [
      {
        type: "tool_use",
        id: "tool-1",
        name: "read_file",
        input: { file_path: "/large_tool_results/result-1" },
      },
    ]);
    assert.deepEqual(sanitized.tool_calls, message.tool_calls);
  });

  it("normalizes an empty assistant string that carries tool calls", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "tool-2",
          name: "call_crm_api",
          args: { endpoint: "/api/Property/ListProperties" },
          type: "tool_call",
        },
      ],
    });

    const [sanitized] = removeEmptyAssistantTextBlocks([message]);

    assert.ok(AIMessage.isInstance(sanitized));
    assert.deepEqual(sanitized.content, []);
    assert.deepEqual(sanitized.tool_calls, message.tool_calls);
  });

  it("removes whitespace-only blocks and empty assistant messages", () => {
    const toolMessage = new AIMessage({
      content: [
        { type: "text", text: "   \n" },
        {
          type: "tool_use",
          id: "tool-3",
          name: "call_crm_api",
          input: {},
        },
      ],
    });
    const emptyMessage = new AIMessage("  ");

    const sanitized = removeEmptyAssistantTextBlocks([toolMessage, emptyMessage]);

    assert.equal(sanitized.length, 1);
    assert.deepEqual(sanitized[0]?.content, [
      {
        type: "tool_use",
        id: "tool-3",
        name: "call_crm_api",
        input: {},
      },
    ]);
  });

  it("leaves user messages and non-empty assistant content unchanged", () => {
    const user = new HumanMessage("hello");
    const assistant = new AIMessage({
      content: [{ type: "text", text: "hello back" }],
    });

    const sanitized = removeEmptyAssistantTextBlocks([user, assistant]);

    assert.equal(sanitized[0], user);
    assert.equal(sanitized[1], assistant);
  });
});
