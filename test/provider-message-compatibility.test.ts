import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { removeEmptyAssistantTextBlocks, repairEmptyToolArguments, providerMessageCompatibilityMiddleware } from "../src/providers/message-compatibility.js";

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

  it("repairs the observed empty-argument provider call while preserving IDs, raw calls and response metadata", async () => {
    const statusTool = tool(async () => "configured", { name: "get_workflow_status", description: "Check setup", schema: z.object({}) });
    const message = new AIMessage({
      id: "provider-message", name: "model", content: "", tool_calls: [],
      invalid_tool_calls: [{ name: "get_workflow_status", args: "", id: "toolu_empty", error: "Unexpected end of JSON input", type: "invalid_tool_call" }],
      additional_kwargs: { tool_calls: [{ id: "toolu_empty", type: "function", function: { name: "get_workflow_status", arguments: "" } }], reasoning_content: "provider reasoning" },
      response_metadata: { model_name: "synthetic", finish_reason: "tool_calls" }, usage_metadata: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    });
    const repaired = await repairEmptyToolArguments(message, [statusTool]);
    assert.deepEqual(repaired.tool_calls, [{ id: "toolu_empty", name: "get_workflow_status", args: {}, type: "tool_call" }]);
    assert.deepEqual(repaired.invalid_tool_calls, []);
    assert.equal(repaired.additional_kwargs.tool_calls?.[0]?.function.arguments, "{}");
    assert.equal(repaired.id, message.id); assert.equal(repaired.name, message.name); assert.equal(repaired.content, message.content);
    assert.deepEqual(repaired.response_metadata, message.response_metadata); assert.deepEqual(repaired.usage_metadata, message.usage_metadata);
    assert.equal(repaired.additional_kwargs.reasoning_content, "provider reasoning");
    assert.equal(message.invalid_tool_calls?.length, 1); assert.equal(message.additional_kwargs.tool_calls?.[0]?.function.arguments, "");
  });

  it("does not repair unknown tools, missing required arguments, or nonempty malformed JSON", async () => {
    const requiredTool = tool(async () => "unused", { name: "register_lead", description: "Required input", schema: z.object({ name: z.string() }) });
    const emptyTool = tool(async () => "unused", { name: "get_workflow_status", description: "Check setup", schema: z.object({}) });
    for (const invalid of [
      { name: "register_lead", args: "", id: "required" },
      { name: "unknown_tool", args: "", id: "unknown" },
      { name: "get_workflow_status", args: '{"broken":', id: "malformed" },
    ]) {
      const message = new AIMessage({ content: "", invalid_tool_calls: [{ ...invalid, type: "invalid_tool_call" }] });
      assert.equal(await repairEmptyToolArguments(message, [requiredTool, emptyTool]), message);
    }
  });

  it("fails visibly instead of returning an empty final response for unrepaired invalid calls", async () => {
    const message = new AIMessage({ content: "", invalid_tool_calls: [{ id: "invalid", name: "unknown_tool", args: "", type: "invalid_tool_call" }] });
    await assert.rejects(async () => {
      await providerMessageCompatibilityMiddleware.wrapModelCall!({ messages: [], tools: [] } as never, async () => message);
    }, /tool calls were not executed/);
  });
});
