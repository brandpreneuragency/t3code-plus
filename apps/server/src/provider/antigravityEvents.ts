import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

const MAX_TOOL_DETAIL_CHARS = 8_192;
const MAX_DIAGNOSTIC_CHARS = 256;

export type AntigravityTerminalStatus =
  | "SUCCESS"
  | "ERROR"
  | "CANCELED"
  | "INTERRUPTED"
  | "INVALID"
  | "WAITING"
  | "RUNNING";

export interface AntigravityCumulativeUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly thinkingTokens?: number;
  readonly cacheReadTokens?: number;
  readonly totalTokens?: number;
}

export type AntigravityParsedEvent =
  | { readonly kind: "init"; readonly conversationId?: string }
  | {
      readonly kind: "text";
      readonly state: "ACTIVE" | "DONE";
      readonly stepIndex: number;
      readonly conversationId?: string;
      readonly text: string;
    }
  | {
      readonly kind: "tool";
      readonly state: "ACTIVE" | "DONE";
      readonly stepIndex: number;
      readonly conversationId?: string;
      readonly toolName: string;
      readonly detail?: string;
    }
  | {
      readonly kind: "result";
      readonly status: AntigravityTerminalStatus;
      readonly conversationId?: string;
      readonly response?: string;
      readonly usage?: AntigravityCumulativeUsage;
      readonly error?: string;
    }
  | { readonly kind: "diagnostic"; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function textString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function bounded(value: string, maxChars = MAX_TOOL_DETAIL_CHARS): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function boundedJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return bounded(JSON.stringify(value), 4_096);
  } catch {
    return "[unserializable]";
  }
}

function diagnostic(message: string): AntigravityParsedEvent {
  return { kind: "diagnostic", message: bounded(message, MAX_DIAGNOSTIC_CHARS) };
}

export function parseAntigravityCumulativeUsage(
  value: unknown,
): AntigravityCumulativeUsage | undefined {
  if (!isRecord(value)) return undefined;

  const inputTokens = nonNegativeInteger(value.input_tokens);
  const outputTokens = nonNegativeInteger(value.output_tokens);
  const thinkingTokens = nonNegativeInteger(value.thinking_tokens);
  const cacheReadTokens = nonNegativeInteger(value.cache_read_tokens);
  const totalTokens = nonNegativeInteger(value.total_tokens);
  const usage: AntigravityCumulativeUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function parseToolDetail(toolInfo: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const parameters = boundedJson(toolInfo.parameters);
  if (parameters) parts.push(`Input: ${parameters}`);

  const output = textString(toolInfo.output);
  if (output) parts.push(`Output: ${bounded(output, 4_096)}`);

  if (isRecord(toolInfo.error)) {
    const type = nonEmptyString(toolInfo.error.type);
    const message = nonEmptyString(toolInfo.error.message);
    if (type || message) parts.push(`Error: ${[type, message].filter(Boolean).join(": ")}`);
  }

  const detail = parts.join("\n");
  return detail ? bounded(detail) : undefined;
}

export function parseAntigravityNdjsonLine(line: string): AntigravityParsedEvent {
  let envelope: unknown;
  try {
    envelope = JSON.parse(line);
  } catch {
    return diagnostic("Ignored malformed Antigravity NDJSON.");
  }

  if (!isRecord(envelope)) {
    return diagnostic("Ignored non-object Antigravity NDJSON.");
  }

  const eventName = nonEmptyString(envelope.event)?.toLowerCase();
  if (eventName === "init") {
    const conversationId = nonEmptyString(envelope.conversation_id);
    return { kind: "init", ...(conversationId ? { conversationId } : {}) };
  }

  if (eventName === "step_update") {
    if (!isRecord(envelope.step_update)) {
      return diagnostic("Ignored Antigravity step_update without a payload.");
    }

    const step = envelope.step_update;
    const stepType = nonEmptyString(step.step_type)?.toLowerCase();
    if (stepType === "checkpoint" || stepType === "user_input") {
      return diagnostic(`Ignored Antigravity ${stepType} step.`);
    }

    const state = nonEmptyString(step.state)?.toUpperCase();
    const stepIndex = nonNegativeInteger(step.step_index);
    if ((state !== "ACTIVE" && state !== "DONE") || stepIndex === undefined) {
      return diagnostic("Ignored Antigravity step with an invalid state or step index.");
    }

    const conversationId = nonEmptyString(step.conversation_id);
    if (stepType === "agent_response") {
      const text = textString(step.text_delta);
      if (!text) return diagnostic("Ignored empty Antigravity agent-response delta.");
      return {
        kind: "text",
        state,
        stepIndex,
        ...(conversationId ? { conversationId } : {}),
        text,
      };
    }

    if (stepType === "tool") {
      const toolInfo = isRecord(step.tool_info) ? step.tool_info : {};
      const toolName =
        nonEmptyString(step.tool_name) ?? nonEmptyString(toolInfo.name) ?? "Antigravity tool";
      const detail = parseToolDetail(toolInfo);
      return {
        kind: "tool",
        state,
        stepIndex,
        ...(conversationId ? { conversationId } : {}),
        toolName,
        ...(detail ? { detail } : {}),
      };
    }

    return diagnostic(`Ignored unknown Antigravity step type '${stepType ?? "missing"}'.`);
  }

  if (eventName === "result") {
    if (!isRecord(envelope.result)) {
      return diagnostic("Ignored Antigravity result without a payload.");
    }

    const result = envelope.result;
    const statusValue = nonEmptyString(result.status)?.toUpperCase();
    const validStatuses: ReadonlySet<string> = new Set([
      "SUCCESS",
      "ERROR",
      "CANCELED",
      "INTERRUPTED",
      "INVALID",
      "WAITING",
      "RUNNING",
    ]);
    if (!statusValue || !validStatuses.has(statusValue)) {
      return diagnostic(`Ignored Antigravity result with status '${statusValue ?? "missing"}'.`);
    }

    const conversationId = nonEmptyString(result.conversation_id);
    const response = textString(result.response);
    const error = nonEmptyString(result.error);
    const usage = parseAntigravityCumulativeUsage(result.usage);
    return {
      kind: "result",
      status: statusValue as AntigravityTerminalStatus,
      ...(conversationId ? { conversationId } : {}),
      ...(response ? { response } : {}),
      ...(usage ? { usage } : {}),
      ...(error ? { error: bounded(error) } : {}),
    };
  }

  return diagnostic(`Ignored unknown Antigravity event '${eventName ?? "missing"}'.`);
}

function counterDelta(current: number | undefined, previous: number | undefined) {
  if (current === undefined) return undefined;
  if (previous === undefined || current < previous) return current;
  return current - previous;
}

export function antigravityUsageSnapshot(
  usage: AntigravityCumulativeUsage | undefined,
  previous?: AntigravityCumulativeUsage,
): ThreadTokenUsageSnapshot | undefined {
  if (!usage) return undefined;

  const reset = previous
    ? (
        [
          [usage.inputTokens, previous.inputTokens],
          [usage.outputTokens, previous.outputTokens],
          [usage.thinkingTokens, previous.thinkingTokens],
          [usage.cacheReadTokens, previous.cacheReadTokens],
          [usage.totalTokens, previous.totalTokens],
        ] as const
      ).some(([current, prior]) => current !== undefined && prior !== undefined && current < prior)
    : false;
  const baseline = reset ? undefined : previous;

  const usedTokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const previousUsedTokens =
    baseline?.totalTokens ?? (baseline?.inputTokens ?? 0) + (baseline?.outputTokens ?? 0);
  return {
    usedTokens,
    totalProcessedTokens: usedTokens,
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.thinkingTokens !== undefined ? { reasoningOutputTokens: usage.thinkingTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cachedInputTokens: usage.cacheReadTokens } : {}),
    lastUsedTokens:
      counterDelta(usedTokens, baseline ? previousUsedTokens : undefined) ?? usedTokens,
    ...(usage.inputTokens !== undefined
      ? { lastInputTokens: counterDelta(usage.inputTokens, baseline?.inputTokens) }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { lastOutputTokens: counterDelta(usage.outputTokens, baseline?.outputTokens) }
      : {}),
    ...(usage.thinkingTokens !== undefined
      ? {
          lastReasoningOutputTokens: counterDelta(usage.thinkingTokens, baseline?.thinkingTokens),
        }
      : {}),
    ...(usage.cacheReadTokens !== undefined
      ? {
          lastCachedInputTokens: counterDelta(usage.cacheReadTokens, baseline?.cacheReadTokens),
        }
      : {}),
  };
}
