import { AIMessage, type AIMessageFields, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import {
  classifyAiFailure,
  logAiEvent,
  serializeError,
} from "../observability.js";

function isEmptyTextBlock(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const block = value as { type?: unknown; text?: unknown };
  return (
    (block.type === "text" || block.type === "text_delta") &&
    typeof block.text === "string" &&
    block.text.trim().length === 0
  );
}

interface SanitizedMessages {
  messages: BaseMessage[];
  removedBlocks: number;
  removedMessages: number;
  normalizedStringMessages: number;
}

function cloneAssistantMessage(
  message: AIMessage,
  content: AIMessage["content"],
  overrides: Pick<AIMessageFields, "tool_calls" | "invalid_tool_calls" | "additional_kwargs"> = {}
): AIMessage {
  return new AIMessage({
    content,
    id: message.id,
    name: message.name,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    tool_calls: message.tool_calls,
    invalid_tool_calls: message.invalid_tool_calls,
    usage_metadata: message.usage_metadata,
    ...overrides,
  });
}

/** Some compatible providers serialize no-argument tool calls as "" instead of "{}". */
export async function repairEmptyToolArguments(message: AIMessage, tools: readonly unknown[]): Promise<AIMessage> {
  const repaired = new Set<NonNullable<AIMessage["invalid_tool_calls"]>[number]>();
  const toolCalls = [...message.tool_calls ?? []];
  for (const call of message.invalid_tool_calls ?? []) {
    if (!call.id || !call.name || typeof call.args !== "string" || call.args.trim() || toolCalls.some(valid => valid.id === call.id)) continue;
    const bound = tools.find(tool => typeof tool === "object" && tool !== null && "name" in tool && tool.name === call.name) as { schema?: { safeParseAsync?: (value: unknown) => Promise<{ success: boolean }> } } | undefined;
    if (typeof bound?.schema?.safeParseAsync !== "function") continue;
    try {
      if (!(await bound.schema.safeParseAsync({})).success) continue;
    } catch { continue; }
    toolCalls.push({ id: call.id, name: call.name, args: {}, type: "tool_call" });
    repaired.add(call);
  }
  if (!repaired.size) return message;
  const repairedIds = new Map([...repaired].map(call => [call.id, call.name]));
  const rawCalls = message.additional_kwargs.tool_calls?.map(call => repairedIds.get(call.id) === call.function?.name
    ? { ...call, function: { ...call.function, arguments: "{}" } } : call);
  return cloneAssistantMessage(message, message.content, {
    tool_calls: toolCalls,
    invalid_tool_calls: message.invalid_tool_calls?.filter(call => !repaired.has(call)),
    additional_kwargs: { ...message.additional_kwargs, ...(rawCalls ? { tool_calls: rawCalls } : {}) },
  });
}

function sanitizeAssistantMessages(messages: BaseMessage[]): SanitizedMessages {
  const sanitized: BaseMessage[] = [];
  let removedBlocks = 0;
  let removedMessages = 0;
  let normalizedStringMessages = 0;

  for (const message of messages) {
    if (!AIMessage.isInstance(message)) {
      sanitized.push(message);
      continue;
    }

    const toolCalls = message.tool_calls ?? [];
    if (typeof message.content === "string") {
      if (message.content.trim().length > 0) {
        sanitized.push(message);
      } else if (toolCalls.length > 0) {
        // ChatAnthropic turns tool_calls into tool_use blocks. An empty string
        // would become a rejected text block before those tool calls.
        sanitized.push(cloneAssistantMessage(message, []));
        normalizedStringMessages += 1;
      } else {
        removedMessages += 1;
      }
      continue;
    }

    const content = message.content.filter((block) => !isEmptyTextBlock(block));
    removedBlocks += message.content.length - content.length;
    if (content.length === 0 && toolCalls.length === 0) {
      removedMessages += 1;
      continue;
    }
    sanitized.push(
      content.length === message.content.length
        ? message
        : cloneAssistantMessage(message, content)
    );
  }

  return {
    messages: sanitized,
    removedBlocks,
    removedMessages,
    normalizedStringMessages,
  };
}

/**
 * Anthropic-compatible endpoints reject empty text blocks, although streamed
 * tool-call responses can contain one before their tool_use block. Remove only
 * those empty blocks and preserve the message and its tool-call metadata.
 */
export function removeEmptyAssistantTextBlocks(
  messages: BaseMessage[]
): BaseMessage[] {
  return sanitizeAssistantMessages(messages).messages;
}

export const providerMessageCompatibilityMiddleware = createMiddleware({
  name: "ProviderMessageCompatibilityMiddleware",
  wrapModelCall: async (request, handler) => {
    const sanitized = sanitizeAssistantMessages(request.messages);
    if (
      sanitized.removedBlocks > 0 ||
      sanitized.removedMessages > 0 ||
      sanitized.normalizedStringMessages > 0
    ) {
      logAiEvent("warn", "provider.messages_sanitized", {
        provider: process.env.LLM_PROVIDER || "unknown",
        model: process.env.LLM_MODEL || "unknown",
        messageCount: request.messages.length,
        removedBlocks: sanitized.removedBlocks,
        removedMessages: sanitized.removedMessages,
        normalizedStringMessages: sanitized.normalizedStringMessages,
      });
    }

    try {
      const response = await handler({ ...request, messages: sanitized.messages });
      const normalized = await repairEmptyToolArguments(response, request.tools);
      if (normalized !== response) logAiEvent("warn", "provider.empty_tool_arguments_normalized", {
        provider: process.env.LLM_PROVIDER || "unknown",
        model: process.env.LLM_MODEL || "unknown",
        repairedCalls: (response.invalid_tool_calls?.length ?? 0) - (normalized.invalid_tool_calls?.length ?? 0),
      });
      if (normalized.invalid_tool_calls?.length) throw new Error("The model provider returned missing or malformed tool arguments. Those tool calls were not executed; please retry with the required details.");
      return normalized;
    } catch (error) {
      const serialized = serializeError(error);
      logAiEvent("error", "provider.request_failed", {
        provider: process.env.LLM_PROVIDER || "unknown",
        model: process.env.LLM_MODEL || "unknown",
        messageCount: sanitized.messages.length,
        category: classifyAiFailure(serialized),
        error: serialized,
      });
      throw error;
    }
  },
});
