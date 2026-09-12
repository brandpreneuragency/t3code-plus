import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

export type CommandCodeParsedLine =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly status: "running" | "completed" | "failed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly detail?: string;
    }
  | {
      readonly kind: "result";
      readonly subtype: string;
      readonly sessionId?: string;
      readonly stopReason?: string;
      readonly usage?: unknown;
      readonly finalText: string;
      readonly error?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function textDelta(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "event" && isRecord(value.event)) {
    return value.event;
  }
  return value;
}

function textFromRecord(record: Record<string, unknown>): string | undefined {
  return textDelta(record.text) ?? textDelta(record.delta);
}

function parseToolStatus(type: string): "running" | "completed" | "failed" | undefined {
  if (type === "tool_running" || type === "tool_queued" || type === "tool_update") {
    return "running";
  }
  if (type === "tool_completed") return "completed";
  if (type === "tool_errored" || type === "tool_denied" || type === "tool_hook_blocked") {
    return "failed";
  }
  return undefined;
}

export function parseCommandCodeNdjsonLine(line: string): CommandCodeParsedLine | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  if (parsed.type === "result") {
    const sessionId = nonEmptyString(parsed.sessionId);
    const stopReason = nonEmptyString(parsed.stopReason);
    const error = nonEmptyString(parsed.error);
    return {
      kind: "result",
      subtype: nonEmptyString(parsed.subtype) ?? "success",
      ...(sessionId ? { sessionId } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
      finalText: typeof parsed.finalText === "string" ? parsed.finalText : "",
      ...(error ? { error } : {}),
    };
  }

  const event = eventRecord(parsed);
  if (!event) return undefined;
  const type = nonEmptyString(event.type);
  if (!type) return undefined;

  if (type === "text_delta" || type === "message_update") {
    const text = textFromRecord(event);
    return text ? { kind: "text", text } : undefined;
  }
  if (type === "thinking_delta" || type === "thinking_start" || type === "thinking_end") {
    const text = textFromRecord(event);
    return text ? { kind: "thinking", text } : undefined;
  }

  const toolStatus = parseToolStatus(type);
  if (toolStatus) {
    const toolCallId =
      nonEmptyString(event.toolCallId) ?? nonEmptyString(event.id) ?? nonEmptyString(event.callId);
    const toolName =
      nonEmptyString(event.toolName) ?? nonEmptyString(event.name) ?? nonEmptyString(event.tool);
    if (!toolCallId || !toolName) return undefined;
    const detail = nonEmptyString(event.description) ?? nonEmptyString(event.detail);
    return {
      kind: "tool",
      status: toolStatus,
      toolCallId,
      toolName,
      ...(detail ? { detail } : {}),
    };
  }

  return undefined;
}

function readCount(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return undefined;
}

export function commandCodeUsageSnapshot(usage: unknown): ThreadTokenUsageSnapshot | undefined {
  if (!isRecord(usage)) return undefined;
  const inputTokens = readCount(usage, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const outputTokens = readCount(usage, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const cachedInputTokens = readCount(usage, [
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheReadTokens",
    "cache_read_tokens",
  ]);
  const reasoningOutputTokens = readCount(usage, [
    "reasoningOutputTokens",
    "reasoning_output_tokens",
    "reasoningTokens",
    "reasoning_tokens",
  ]);
  const usedTokens =
    readCount(usage, ["totalTokens", "total_tokens", "usedTokens"]) ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  if (usedTokens === undefined) return undefined;
  return {
    usedTokens,
    totalProcessedTokens: usedTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    lastUsedTokens: usedTokens,
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
  };
}
