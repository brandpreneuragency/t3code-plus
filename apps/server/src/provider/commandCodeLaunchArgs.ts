export const COMMAND_CODE_DEFAULT_BINARY = "command-code";

export function commandCodeVersionArgs(): ReadonlyArray<string> {
  return ["--version"];
}

export function commandCodeStatusArgs(): ReadonlyArray<string> {
  return ["status", "--json"];
}

export function commandCodeListModelsArgs(): ReadonlyArray<string> {
  return ["--list-models"];
}

export function commandCodePrintTurnArgs(input: {
  readonly query: string;
  readonly sessionId?: string | undefined;
  readonly model?: string | undefined;
  readonly plan?: boolean | undefined;
}): ReadonlyArray<string> {
  const args = [
    "-p",
    input.query,
    "--output-format",
    "json",
    "--skip-onboarding",
    "--trust",
    input.plan ? "--plan" : "--yolo",
  ];
  if (input.sessionId) {
    args.push("--resume", input.sessionId);
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  return args;
}
