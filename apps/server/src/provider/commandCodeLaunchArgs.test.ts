import { describe, expect, it } from "@effect/vitest";

import {
  COMMAND_CODE_DEFAULT_BINARY,
  commandCodeListModelsArgs,
  commandCodePrintTurnArgs,
  commandCodeStatusArgs,
  commandCodeVersionArgs,
} from "./commandCodeLaunchArgs.ts";

describe("commandCodeLaunchArgs", () => {
  it("uses the portable binary name", () => {
    expect(COMMAND_CODE_DEFAULT_BINARY).toBe("command-code");
  });

  it("builds probe argument lists", () => {
    expect(commandCodeVersionArgs()).toEqual(["--version"]);
    expect(commandCodeStatusArgs()).toEqual(["status", "--json"]);
    expect(commandCodeListModelsArgs()).toEqual(["--list-models"]);
  });

  it("always prints JSON, skips onboarding, and trusts the project", () => {
    expect(commandCodePrintTurnArgs({ query: "fix lint" })).toEqual([
      "-p",
      "fix lint",
      "--output-format",
      "json",
      "--skip-onboarding",
      "--trust",
      "--yolo",
    ]);
  });

  it("uses plan instead of yolo when the thread is in plan mode", () => {
    expect(commandCodePrintTurnArgs({ query: "explore auth", plan: true })).toEqual([
      "-p",
      "explore auth",
      "--output-format",
      "json",
      "--skip-onboarding",
      "--trust",
      "--plan",
    ]);
  });

  it("resumes a stored session and pins the selected model", () => {
    expect(
      commandCodePrintTurnArgs({
        query: "continue",
        sessionId: "9f4e1c0a",
        model: "deepseek/deepseek-v4-flash",
      }),
    ).toEqual([
      "-p",
      "continue",
      "--output-format",
      "json",
      "--skip-onboarding",
      "--trust",
      "--yolo",
      "--resume",
      "9f4e1c0a",
      "--model",
      "deepseek/deepseek-v4-flash",
    ]);
  });
});
