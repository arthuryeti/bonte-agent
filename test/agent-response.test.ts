import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractAllMessageText,
  extractContentText,
  extractLastAssistantText,
} from "../src/agent-response.js";

describe("agent response extraction", () => {
  it("extracts Kimi Anthropic text content blocks", () => {
    const result = {
      messages: [
        { role: "user", content: "hey there" },
        {
          role: "assistant",
          content: [
            {
              index: 0,
              type: "text",
              text: "Hey! What can I help you with today?",
            },
          ],
        },
      ],
      todos: [],
      files: {},
    };

    assert.equal(
      extractLastAssistantText(result),
      "Hey! What can I help you with today?"
    );
  });

  it("extracts serialized LangChain AIMessageChunk content", () => {
    const result = {
      messages: [
        {
          lc: 1,
          type: "constructor",
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: {
            content: [{ index: 0, type: "text", text: "Hello from K3" }],
          },
        },
      ],
    };

    assert.equal(extractLastAssistantText(result), "Hello from K3");
  });

  it("collects text tool outputs for hidden media delivery", () => {
    const result = {
      messages: [
        { role: "tool", content: '{"mediaTag":"MEDIA:/tmp/example.pdf"}' },
        {
          role: "assistant",
          content: [{ type: "text", text: "Your PDF is ready." }],
        },
      ],
    };

    assert.equal(
      extractAllMessageText(result),
      '{"mediaTag":"MEDIA:/tmp/example.pdf"}\nYour PDF is ready.'
    );
  });

  it("ignores non-text Anthropic content blocks", () => {
    assert.equal(
      extractContentText([
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "Visible answer" },
        { type: "tool_use", name: "example" },
      ]),
      "Visible answer"
    );
  });
});
