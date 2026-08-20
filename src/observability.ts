const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const MAX_STACK_LENGTH = 4_000;
const MAX_CAUSE_DEPTH = 4;

export type AiFailureCategory =
  | "aborted"
  | "crm_access"
  | "provider_authentication"
  | "provider_empty_content"
  | "provider_rate_limit"
  | "provider_request"
  | "timeout"
  | "unknown";

export interface SerializedError {
  name: string;
  message: string;
  code?: string | number;
  status?: string | number;
  stack?: string;
  cause?: SerializedError;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

function errorField(
  error: Record<string, unknown>,
  key: "code" | "status"
): string | number | undefined {
  const value = error[key];
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

export function serializeError(
  value: unknown,
  depth = 0
): SerializedError {
  if (!(value instanceof Error)) {
    return {
      name: "Error",
      message: truncate(String(value), MAX_ERROR_MESSAGE_LENGTH),
    };
  }

  const record = value as Error & Record<string, unknown>;
  const serialized: SerializedError = {
    name: value.name || "Error",
    message: truncate(value.message || "Unknown error", MAX_ERROR_MESSAGE_LENGTH),
  };
  const code = errorField(record, "code");
  const status = errorField(record, "status");
  if (code !== undefined) serialized.code = code;
  if (status !== undefined) serialized.status = status;
  if (value.stack) serialized.stack = truncate(value.stack, MAX_STACK_LENGTH);
  if (depth < MAX_CAUSE_DEPTH && value.cause !== undefined) {
    serialized.cause = serializeError(value.cause, depth + 1);
  }
  return serialized;
}

function errorSearchText(error: SerializedError): string {
  return [
    error.name,
    error.message,
    error.code,
    error.status,
    error.cause ? errorSearchText(error.cause) : "",
  ]
    .filter((value) => value !== undefined)
    .join(" ")
    .toLowerCase();
}

export function classifyAiFailure(error: SerializedError): AiFailureCategory {
  const text = errorSearchText(error);
  if (/abort|cancel/.test(text)) return "aborted";
  if (/timeout|timed out|etimedout/.test(text)) return "timeout";
  if (/text content is empty|empty text|empty content/.test(text)) {
    return "provider_empty_content";
  }
  if (/429|rate.?limit|too many requests/.test(text)) {
    return "provider_rate_limit";
  }
  if (/401|unauthori[sz]ed|invalid api key|authentication/.test(text)) {
    return "provider_authentication";
  }
  if (/crm|cloudflare|security service|403/.test(text)) return "crm_access";
  if (/400|invalid_request|provider|model|middlewareerror/.test(text)) {
    return "provider_request";
  }
  return "unknown";
}

export function logAiEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    release: process.env.APP_RELEASE || process.env.SOURCE_COMMIT || "unknown",
    ...fields,
  });
  const line = `[AI] ${payload}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
