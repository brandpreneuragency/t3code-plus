import { assert, describe, it } from "@effect/vitest";

import { antigravityPrintTurnArgs, antigravityUserMessage } from "./antigravityLaunchArgs.ts";

function assertFlagValue(args: ReadonlyArray<string>, flag: string, value: string) {
  const index = args.indexOf(flag);
  assert.isAtLeast(index, 0, `missing ${flag}`);
  assert.strictEqual(args[index + 1], value);
}

describe("antigravityPrintTurnArgs", () => {
  it("maps supervised and auto to sandboxed plan mode", () => {
    for (const runtimeMode of ["supervised", "auto"] as const) {
      const args = antigravityPrintTurnArgs({ runtimeMode });
      assert.deepEqual(args, [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--print-timeout",
        "24h",
        "--mode",
        "plan",
        "--sandbox",
      ]);
    }
  });

  it("maps auto-accept edits without silently granting full access", () => {
    const args = antigravityPrintTurnArgs({ runtimeMode: "auto-accept-edits" });
    assert.include(args, "accept-edits");
    assert.notInclude(args, "--dangerously-skip-permissions");
    assert.notInclude(args, "--sandbox");
  });

  it("only grants full access explicitly", () => {
    const args = antigravityPrintTurnArgs({
      runtimeMode: "full-access",
      conversationId: "conversation-1",
      model: "model-1",
      attachmentDirectories: ["C:\\work"],
    });
    assert.include(args, "--dangerously-skip-permissions");
    assertFlagValue(args, "--conversation", "conversation-1");
    assertFlagValue(args, "--model", "model-1");
    assertFlagValue(args, "--add-dir", "C:\\work");
  });

  it("lets plan interaction mode override full-access flags", () => {
    const args = antigravityPrintTurnArgs({ runtimeMode: "full-access", plan: true });
    assert.include(args, "plan");
    assert.notInclude(args, "--dangerously-skip-permissions");
  });

  it("writes the prompt exclusively to NDJSON stdin", () => {
    assert.strictEqual(
      antigravityUserMessage("hello"),
      '{"event":"user","message":{"content":"hello"}}\n',
    );
  });
});
