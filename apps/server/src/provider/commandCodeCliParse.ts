import { extractAuthBoolean } from "./providerSnapshot.ts";

export interface CommandCodeListedModel {
  readonly slug: string;
  readonly name: string;
}

export interface CommandCodeStatus {
  readonly authenticated: boolean | undefined;
}

const MODEL_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*(?:\/[a-zA-Z0-9._+-]+)?$/;
const LOOKS_LIKE_HEADING = /^(available models|open source|anthropic|openai|google|xai|deepseek)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function modelFromUnknown(value: unknown): CommandCodeListedModel | undefined {
  if (typeof value === "string") {
    const slug = value.trim();
    return MODEL_SLUG_PATTERN.test(slug) ? { slug, name: slug } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const slug =
    nonEmptyString(value.id) ?? nonEmptyString(value.slug) ?? nonEmptyString(value.model);
  if (!slug || !MODEL_SLUG_PATTERN.test(slug)) return undefined;
  return { slug, name: nonEmptyString(value.name) ?? slug };
}

function modelsFromJson(value: unknown): CommandCodeListedModel[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const model = modelFromUnknown(entry);
      return model ? [model] : [];
    });
  }
  if (!isRecord(value)) return [];
  for (const key of ["models", "data", "items"] as const) {
    const nested = modelsFromJson(value[key]);
    if (nested.length > 0) return nested;
  }
  return [];
}

function firstJsonValue(output: string): unknown | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[\[{]/);
    if (start < 0) return undefined;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return undefined;
    }
  }
}

function modelsFromText(output: string): CommandCodeListedModel[] {
  const seen = new Set<string>();
  const models: CommandCodeListedModel[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*•]\s+/, "");
    if (!line || LOOKS_LIKE_HEADING.test(line)) continue;
    const token = line.split(/\s+/)[0] ?? "";
    if (!MODEL_SLUG_PATTERN.test(token) || seen.has(token)) continue;
    if (!token.includes("/") && !token.includes("-") && !token.includes(".")) continue;
    seen.add(token);
    models.push({ slug: token, name: token });
  }
  return models;
}

export function parseCommandCodeListModels(output: string): ReadonlyArray<CommandCodeListedModel> {
  const jsonModels = modelsFromJson(firstJsonValue(output));
  if (jsonModels.length > 0) return jsonModels;
  return modelsFromText(output);
}

export function parseCommandCodeStatus(output: string): CommandCodeStatus {
  const parsed = firstJsonValue(output);
  return { authenticated: extractAuthBoolean(parsed) };
}

export function messageForCommandCodeExitCode(code: number): string | undefined {
  switch (code) {
    case 3:
      return "Command Code is not authenticated. Run `command-code login` in a terminal.";
    case 4:
      return "Command Code denied a permission required for this run.";
    case 5:
      return "Command Code is rate limited. Try again shortly.";
    case 6:
      return "Command Code could not reach its API.";
    case 7:
      return "Command Code's API returned a server error.";
    case 8:
      return "Command Code hit its max-turns limit before finishing.";
    case 9:
      return "Command Code's model produced no response.";
    case 10:
      return "Command Code does not have enough credits for this request.";
    case 130:
      return "Command Code was interrupted.";
    default:
      return undefined;
  }
}
