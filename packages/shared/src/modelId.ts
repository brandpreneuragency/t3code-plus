/**
 * Matching between llm-monitor catalogue ids and T3 provider model slugs.
 *
 * Both sides spell the same model several ways: `claude-opus-4.6`,
 * `claude-opus-4-6`, and `claude-opus-4-6-20251117` are one model. Vendor is
 * deliberately not a join key — the catalogue's provider column carries
 * case-variant duplicates and harness names rather than vendors.
 */

const DATE_SUFFIX = /-20\d{6}$/;
const REPEATED_DASH = /-{2,}/g;
const TRAILING_ZERO_MINOR = /(\d)-0$/;

/**
 * Canonical form for comparison only. Never display this — show the original
 * spelling, because that is what the user's provider actually accepts.
 */
export function normalizeModelId(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  if (lowered === "") return "";
  return lowered
    .replace(DATE_SUFFIX, "")
    .replaceAll(".", "-")
    .replace(REPEATED_DASH, "-")
    .replace(TRAILING_ZERO_MINOR, "$1");
}

/** `openai/gpt-5.6-luna` -> `gpt-5.6-luna`. OpenRouter ids are vendor-scoped. */
export function stripVendorPrefix(alias: string): string {
  const index = alias.lastIndexOf("/");
  return index === -1 ? alias : alias.slice(index + 1);
}

export type CatalogueMatchTier = "exact" | "normalized" | "alias";

export type ProviderModelRef<InstanceId extends string = string> = {
  readonly instanceId: InstanceId;
  readonly slug: string;
};

export type CatalogueMatch<InstanceId extends string = string> = {
  readonly instanceId: InstanceId;
  readonly model: string;
  readonly matchedBy: CatalogueMatchTier;
};

/**
 * Every provider model the catalogue entry corresponds to. Ambiguity is
 * returned rather than resolved: two instances may legitimately expose the
 * same model, and a wrong match is easier to spot than to debug.
 */
export function matchCatalogueEntry<InstanceId extends string>(input: {
  readonly sourceModelId: string;
  readonly aliases: ReadonlyArray<string>;
  readonly providerModels: ReadonlyArray<ProviderModelRef<InstanceId>>;
}): ReadonlyArray<CatalogueMatch<InstanceId>> {
  const sourceLower = input.sourceModelId.trim().toLowerCase();
  const sourceNormalized = normalizeModelId(input.sourceModelId);

  const aliasNormalized = new Set(
    input.aliases
      .map((alias) => normalizeModelId(stripVendorPrefix(alias)))
      .filter((alias) => alias !== ""),
  );

  const matches: Array<CatalogueMatch<InstanceId>> = [];

  for (const providerModel of input.providerModels) {
    const slugLower = providerModel.slug.trim().toLowerCase();
    const slugNormalized = normalizeModelId(providerModel.slug);
    if (slugNormalized === "") continue;

    const tier: CatalogueMatchTier | null =
      slugLower !== "" && slugLower === sourceLower
        ? "exact"
        : sourceNormalized !== "" && slugNormalized === sourceNormalized
          ? "normalized"
          : aliasNormalized.has(slugNormalized)
            ? "alias"
            : null;

    if (tier !== null) {
      matches.push({
        instanceId: providerModel.instanceId,
        model: providerModel.slug,
        matchedBy: tier,
      });
    }
  }

  return matches;
}
