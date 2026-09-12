export interface AntigravityListedModel {
  readonly slug: string;
  readonly name: string;
}

const MODEL_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*(?:\/[a-zA-Z0-9._+-]+)?$/;
const AUTH_PATTERN =
  /(?:not authenticated|authentication required|unauthenticated|not logged in|(?:sign[ -]?in|login) required|missing credentials)/i;

/** Parse only the documented `<slug><TAB><display name>` rows. */
export function parseAntigravityModels(output: string): ReadonlyArray<AntigravityListedModel> {
  const seen = new Set<string>();
  const models: AntigravityListedModel[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const tabIndex = rawLine.indexOf("\t");
    if (tabIndex < 1) continue;

    const slug = rawLine.slice(0, tabIndex).trim();
    const name = rawLine.slice(tabIndex + 1).trim();
    if (!MODEL_SLUG_PATTERN.test(slug) || !name || seen.has(slug)) continue;

    seen.add(slug);
    models.push({ slug, name });
  }

  return models;
}

export function antigravityAuthenticationRequired(output: string): boolean {
  return AUTH_PATTERN.test(output);
}

export function antigravitySupportsStreamJson(help: string): boolean {
  return (
    /--input-format[\s\S]*stream-json/i.test(help) &&
    /--output-format[\s\S]*stream-json/i.test(help)
  );
}

export function antigravityErrorMessage(output: string): string | undefined {
  if (antigravityAuthenticationRequired(output)) {
    return "Antigravity CLI is installed but not authenticated. Run `agy` in a terminal, sign in, then refresh provider status.";
  }
  if (/(?:unknown|invalid|unrecognized) model|model .*not (?:found|recognized)/i.test(output)) {
    return "Antigravity rejected the selected model. Refresh provider status and select an available model.";
  }
  if (/timed? ?out|timeout/i.test(output)) {
    return "Antigravity timed out before completing the turn.";
  }
  if (/permission|approval|soft-denied/i.test(output)) {
    return "Antigravity could not obtain a required headless permission.";
  }
  return undefined;
}
