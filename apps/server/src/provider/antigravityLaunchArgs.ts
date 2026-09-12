export const ANTIGRAVITY_DEFAULT_BINARY = "agy";

export function antigravityVersionArgs(): ReadonlyArray<string> {
  return ["--version"];
}

export function antigravityHelpArgs(): ReadonlyArray<string> {
  return ["--help"];
}

export function antigravityListModelsArgs(): ReadonlyArray<string> {
  return ["models"];
}

export type AntigravityRuntimeMode = "supervised" | "auto" | "auto-accept-edits" | "full-access";

export function antigravityPrintTurnArgs(input: {
  readonly conversationId?: string;
  readonly model?: string;
  readonly runtimeMode: AntigravityRuntimeMode;
  readonly plan?: boolean;
  readonly attachmentDirectories?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "24h",
  ];
  if (input.conversationId) {
    args.push("--conversation", input.conversationId);
  }
  if (input.model) {
    args.push("--model", input.model);
  }

  if (input.plan || input.runtimeMode === "supervised" || input.runtimeMode === "auto") {
    args.push("--mode", "plan");
  } else if (input.runtimeMode === "auto-accept-edits") {
    args.push("--mode", "accept-edits");
  } else {
    args.push("--dangerously-skip-permissions");
  }

  if (input.runtimeMode === "supervised" || input.runtimeMode === "auto") {
    args.push("--sandbox");
  }

  for (const directory of input.attachmentDirectories ?? []) {
    args.push("--add-dir", directory);
  }
  return args;
}

export function antigravityUserMessage(text: string): string {
  return `${JSON.stringify({ event: "user", message: { content: text } })}\n`;
}
