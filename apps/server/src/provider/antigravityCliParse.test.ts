import { assert, describe, it } from "@effect/vitest";

import {
  antigravityAuthenticationRequired,
  antigravityErrorMessage,
  antigravitySupportsStreamJson,
  parseAntigravityModels,
} from "./antigravityCliParse.ts";

describe("Antigravity CLI parsing", () => {
  it("parses only tab-separated model rows and deduplicates slugs", () => {
    assert.deepEqual(
      parseAntigravityModels(
        [
          "Fetching available models...",
          "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
          "bad row without a tab",
          "gemini-3.8-flash-medium\tDuplicate",
          "claude-sonnet-4-6\tClaude Sonnet 4.6",
        ].join("\n"),
      ),
      [
        { slug: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ],
    );
  });

  it("requires both stream-json capabilities", () => {
    assert.isTrue(
      antigravitySupportsStreamJson(
        "--input-format text, stream-json\n--output-format stream-json",
      ),
    );
    assert.isFalse(antigravitySupportsStreamJson("--output-format stream-json"));
  });

  it("recognizes actionable authentication, model, permission, and timeout failures", () => {
    assert.isTrue(antigravityAuthenticationRequired("authentication required"));
    assert.match(antigravityErrorMessage("login required") ?? "", /not authenticated/i);
    assert.match(antigravityErrorMessage("invalid model selection") ?? "", /selected model/i);
    assert.match(antigravityErrorMessage("print timeout") ?? "", /timed out/i);
    assert.match(antigravityErrorMessage("permission soft-denied") ?? "", /permission/i);
  });
});
