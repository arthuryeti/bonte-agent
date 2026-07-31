function messageRecord(message: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== "object") return undefined;
  return message as Record<string, unknown>;
}

function serializedMessageKwargs(
  message: Record<string, unknown>
): Record<string, unknown> | undefined {
  return message.kwargs && typeof message.kwargs === "object"
    ? (message.kwargs as Record<string, unknown>)
    : undefined;
}

function messageContent(message: unknown): unknown {
  const record = messageRecord(message);
  if (!record) return undefined;
  return record.content ?? serializedMessageKwargs(record)?.content;
}

function isAssistantMessage(message: unknown): boolean {
  const record = messageRecord(message);
  if (!record) return false;

  const runtimeType =
    typeof record._getType === "function"
      ? (record._getType as () => unknown)()
      : record.type ?? record.role;
  if (
    runtimeType === "ai" ||
    runtimeType === "assistant" ||
    runtimeType === "AIMessage" ||
    runtimeType === "AIMessageChunk"
  ) {
    return true;
  }

  if (Array.isArray(record.id)) {
    const constructorName = record.id.at(-1);
    return (
      constructorName === "AIMessage" ||
      constructorName === "AIMessageChunk"
    );
  }

  return false;
}

/**
 * Flatten LangChain/OpenAI/Anthropic message content into user-visible text.
 */
export function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";

      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (record.type === "text" && typeof record.content === "string") {
        return record.content;
      }
      return "";
    })
    .join("");
}

/**
 * Return the final assistant reply from a DeepAgent result.
 */
export function extractLastAssistantText(result: unknown): string {
  if (typeof result === "string") return result;

  const record = messageRecord(result);
  if (!record) return "";

  if (Array.isArray(record.messages)) {
    for (let index = record.messages.length - 1; index >= 0; index -= 1) {
      const message = record.messages[index];
      if (!isAssistantMessage(message)) continue;

      const text = extractContentText(messageContent(message));
      if (text) return text;
    }

    // Some compatible runtimes omit role/type metadata. Prefer the last
    // textual message rather than serializing the complete agent state.
    for (let index = record.messages.length - 1; index >= 0; index -= 1) {
      const text = extractContentText(messageContent(record.messages[index]));
      if (text) return text;
    }
  }

  return extractContentText(messageContent(record));
}

/**
 * Collect text from every message, including tool outputs containing MEDIA tags.
 */
export function extractAllMessageText(result: unknown): string {
  const collect = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(collect);

    const record = messageRecord(value);
    if (!record) return [];

    if (Array.isArray(record.messages)) {
      return record.messages.flatMap(collect);
    }

    const text = extractContentText(messageContent(record));
    return text ? [text] : [];
  };

  return collect(result).join("\n");
}
