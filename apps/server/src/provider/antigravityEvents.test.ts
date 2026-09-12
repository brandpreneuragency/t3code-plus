import { assert, describe, it } from "@effect/vitest";

import { antigravityUsageSnapshot, parseAntigravityNdjsonLine } from "./antigravityEvents.ts";

describe("Antigravity NDJSON", () => {
  it("parses the documented init and agent-response events without dropping whitespace", () => {
    assert.deepEqual(
      parseAntigravityNdjsonLine(
        '{"event":"init","conversation_id":"conversation-1","init":{"cwd":"C:/work"}}',
      ),
      { kind: "init", conversationId: "conversation-1" },
    );
    assert.deepEqual(
      parseAntigravityNdjsonLine(
        '{"event":"step_update","step_update":{"conversation_id":"conversation-1","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\\n"}}',
      ),
      {
        kind: "text",
        state: "DONE",
        stepIndex: 2,
        conversationId: "conversation-1",
        text: "\n",
      },
    );
  });

  it("parses and bounds documented tool details", () => {
    const parsed = parseAntigravityNdjsonLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-1",
          step_index: 4,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "echo hello" },
            output: "x".repeat(20_000),
          },
        },
      }),
    );
    assert.deepInclude(parsed, {
      kind: "tool",
      state: "DONE",
      stepIndex: 4,
      toolName: "run_command",
    });
    assert.isAtMost(parsed.kind === "tool" ? (parsed.detail?.length ?? 0) : 0, 8_192);
  });

  it("parses every documented result status and nested conversation ID", () => {
    for (const status of [
      "SUCCESS",
      "ERROR",
      "CANCELED",
      "INTERRUPTED",
      "INVALID",
      "WAITING",
      "RUNNING",
    ] as const) {
      assert.deepInclude(
        parseAntigravityNdjsonLine(
          JSON.stringify({
            event: "result",
            result: { conversation_id: "conversation-2", status, response: "Done" },
          }),
        ),
        { kind: "result", conversationId: "conversation-2", status },
      );
    }
  });

  it("ignores checkpoint, malformed, and unknown events through bounded diagnostics", () => {
    for (const line of [
      "not-json",
      '{"event":"future_event","raw":"secret"}',
      '{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"checkpoint"}}',
    ]) {
      const parsed = parseAntigravityNdjsonLine(line);
      assert.strictEqual(parsed.kind, "diagnostic");
      assert.isAtMost(parsed.kind === "diagnostic" ? parsed.message.length : 0, 256);
    }
  });

  it("converts cumulative usage to deltas and treats resets as fresh baselines", () => {
    const previous = {
      inputTokens: 10,
      outputTokens: 2,
      thinkingTokens: 1,
      cacheReadTokens: 3,
      totalTokens: 12,
    };
    assert.deepInclude(
      antigravityUsageSnapshot(
        {
          inputTokens: 15,
          outputTokens: 4,
          thinkingTokens: 2,
          cacheReadTokens: 7,
          totalTokens: 19,
        },
        previous,
      ) ?? {},
      {
        lastUsedTokens: 7,
        lastInputTokens: 5,
        lastOutputTokens: 2,
        lastReasoningOutputTokens: 1,
        lastCachedInputTokens: 4,
      },
    );
    assert.deepInclude(
      antigravityUsageSnapshot({ inputTokens: 3, outputTokens: 1, totalTokens: 4 }, previous) ?? {},
      { lastUsedTokens: 4, lastInputTokens: 3, lastOutputTokens: 1 },
    );
    assert.deepInclude(
      antigravityUsageSnapshot({ inputTokens: 3, outputTokens: 20, totalTokens: 23 }, previous) ??
        {},
      { lastUsedTokens: 23, lastInputTokens: 3, lastOutputTokens: 20 },
    );
  });
});
