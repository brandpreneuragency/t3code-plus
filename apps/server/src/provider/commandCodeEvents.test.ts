import { describe, expect, it } from "@effect/vitest";

import { commandCodeUsageSnapshot, parseCommandCodeNdjsonLine } from "./commandCodeEvents.ts";

describe("parseCommandCodeNdjsonLine", () => {
  it("reads nested event frames", () => {
    expect(
      parseCommandCodeNdjsonLine(
        JSON.stringify({
          type: "event",
          event: {
            type: "tool_running",
            toolCallId: "call-1",
            toolName: "read_file",
            description: "Read auth.ts",
          },
        }),
      ),
    ).toEqual({
      kind: "tool",
      status: "running",
      toolCallId: "call-1",
      toolName: "read_file",
      detail: "Read auth.ts",
    });
  });

  it("reads text and thinking deltas in either nesting", () => {
    expect(
      parseCommandCodeNdjsonLine(
        JSON.stringify({ type: "event", event: { type: "text_delta", text: "Hello" } }),
      ),
    ).toEqual({ kind: "text", text: "Hello" });
    expect(
      parseCommandCodeNdjsonLine(JSON.stringify({ type: "thinking_delta", delta: "hmm" })),
    ).toEqual({ kind: "thinking", text: "hmm" });
  });

  it("reads the final result line and treats sessionId as optional", () => {
    expect(
      parseCommandCodeNdjsonLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          sessionId: "abc",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 4 },
          finalText: "done",
        }),
      ),
    ).toEqual({
      kind: "result",
      subtype: "success",
      sessionId: "abc",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 4 },
      finalText: "done",
    });
    expect(
      parseCommandCodeNdjsonLine(
        JSON.stringify({ type: "result", subtype: "error", error: "auth" }),
      ),
    ).toEqual({
      kind: "result",
      subtype: "error",
      finalText: "",
      error: "auth",
    });
  });

  it("ignores blank lines, non-JSON, and unknown event types", () => {
    expect(parseCommandCodeNdjsonLine("")).toBeUndefined();
    expect(parseCommandCodeNdjsonLine("not json")).toBeUndefined();
    expect(
      parseCommandCodeNdjsonLine(
        JSON.stringify({ type: "event", event: { type: "future_thing" } }),
      ),
    ).toBeUndefined();
  });
});

describe("commandCodeUsageSnapshot", () => {
  it("maps common token field names onto the thread usage snapshot", () => {
    expect(
      commandCodeUsageSnapshot({
        inputTokens: 12,
        outputTokens: 8,
        cachedInputTokens: 3,
        reasoningTokens: 2,
        totalTokens: 25,
      }),
    ).toEqual({
      usedTokens: 25,
      totalProcessedTokens: 25,
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 8,
      reasoningOutputTokens: 2,
      lastUsedTokens: 25,
      lastInputTokens: 12,
      lastCachedInputTokens: 3,
      lastOutputTokens: 8,
      lastReasoningOutputTokens: 2,
    });
  });

  it("accepts prompt/completion aliases and ignores empty objects", () => {
    expect(commandCodeUsageSnapshot({ prompt_tokens: 5, completion_tokens: 7 })).toEqual({
      usedTokens: 12,
      totalProcessedTokens: 12,
      inputTokens: 5,
      outputTokens: 7,
      lastUsedTokens: 12,
      lastInputTokens: 5,
      lastOutputTokens: 7,
    });
    expect(commandCodeUsageSnapshot({})).toBeUndefined();
    expect(commandCodeUsageSnapshot(undefined)).toBeUndefined();
  });
});
