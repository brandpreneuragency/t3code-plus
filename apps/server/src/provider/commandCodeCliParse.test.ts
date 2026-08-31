import { describe, expect, it } from "@effect/vitest";

import {
  messageForCommandCodeExitCode,
  parseCommandCodeListModels,
  parseCommandCodeStatus,
} from "./commandCodeCliParse.ts";

describe("parseCommandCodeListModels", () => {
  it("reads a JSON array of slugs", () => {
    expect(
      parseCommandCodeListModels('["deepseek/deepseek-v4-flash","claude-sonnet-4-6"]'),
    ).toEqual([
      { slug: "deepseek/deepseek-v4-flash", name: "deepseek/deepseek-v4-flash" },
      { slug: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
    ]);
  });

  it("reads a JSON object with named models", () => {
    expect(
      parseCommandCodeListModels(
        JSON.stringify({
          models: [{ id: "moonshotai/kimi-k2.5", name: "Kimi K2.5" }, { slug: "gpt-5.5" }],
        }),
      ),
    ).toEqual([
      { slug: "moonshotai/kimi-k2.5", name: "Kimi K2.5" },
      { slug: "gpt-5.5", name: "gpt-5.5" },
    ]);
  });

  it("extracts slugs from grouped text output and ignores headings", () => {
    const output = `
Available models
Open Source
  deepseek/deepseek-v4-flash   Fast default
  kimi-k2.5
Anthropic
  claude-sonnet-4-6
`;
    expect(parseCommandCodeListModels(output)).toEqual([
      { slug: "deepseek/deepseek-v4-flash", name: "deepseek/deepseek-v4-flash" },
      { slug: "kimi-k2.5", name: "kimi-k2.5" },
      { slug: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
    ]);
  });

  it("ignores unknown shapes", () => {
    expect(parseCommandCodeListModels("not models")).toEqual([]);
  });
});

describe("parseCommandCodeStatus", () => {
  it("treats authenticated JSON as ready", () => {
    expect(parseCommandCodeStatus('{"authenticated":true,"user":"ada"}')).toEqual({
      authenticated: true,
    });
  });

  it("treats logged-out JSON as unauthenticated", () => {
    expect(parseCommandCodeStatus('{"auth":{"loggedIn":false}}')).toEqual({
      authenticated: false,
    });
  });

  it("returns unknown when status JSON is missing or unreadable", () => {
    expect(parseCommandCodeStatus("not json")).toEqual({ authenticated: undefined });
    expect(parseCommandCodeStatus("{}")).toEqual({ authenticated: undefined });
  });
});

describe("messageForCommandCodeExitCode", () => {
  it("maps auth and credit failures to actionable messages", () => {
    expect(messageForCommandCodeExitCode(3)).toBe(
      "Command Code is not authenticated. Run `command-code login` in a terminal.",
    );
    expect(messageForCommandCodeExitCode(10)).toBe(
      "Command Code does not have enough credits for this request.",
    );
  });

  it("maps other documented headless exit codes", () => {
    expect(messageForCommandCodeExitCode(5)).toBe(
      "Command Code is rate limited. Try again shortly.",
    );
    expect(messageForCommandCodeExitCode(6)).toBe("Command Code could not reach its API.");
    expect(messageForCommandCodeExitCode(8)).toBe(
      "Command Code hit its max-turns limit before finishing.",
    );
    expect(messageForCommandCodeExitCode(130)).toBe("Command Code was interrupted.");
  });

  it("returns undefined for success and unknown codes", () => {
    expect(messageForCommandCodeExitCode(0)).toBeUndefined();
    expect(messageForCommandCodeExitCode(42)).toBeUndefined();
  });
});
