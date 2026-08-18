import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

function isEmptyTextBlock(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const block = value as { type?: unknown; text?: unknown };
  return (
    (block.type === "text" || block.type === "text_delta") &&
    typeof block.text === "string" &&
    block.text.length === 0
  );
}

/**
 * Anthropic-compatible endpoints reject empty text blocks, although streamed
 * tool-call responses can contain one before their tool_use block. Remove only
 * those empty blocks and preserve the message and its tool-call metadata.
 */
export function removeEmptyAssistantTextBlocks(
  messages: BaseMessage[]
): BaseMessage[] {
  return messages.map((message) => {
    if (!AIMessage.isInstance(message) || !Array.isArray(message.content)) {
      return message;
    }

    const content = message.content.filter((block) => !isEmptyTextBlock(block));
    if (content.length === message.content.length) return message;

    return new AIMessage({
      content,
      id: message.id,
      name: message.name,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      tool_calls: message.tool_calls,
      invalid_tool_calls: message.invalid_tool_calls,
      usage_metadata: message.usage_metadata,
    });
  });
}

export const providerMessageCompatibilityMiddleware = createMiddleware({
  name: "ProviderMessageCompatibilityMiddleware",
  wrapModelCall: (request, handler) =>
    handler({
      ...request,
      messages: removeEmptyAssistantTextBlocks(request.messages),
    }),
});
