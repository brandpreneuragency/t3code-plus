import { describe, expect, test } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  filterCatalogueRows,
  formatModelConfidence,
  sortCatalogueRows,
} from "./modelCatalogueRows.ts";

const entry = (name: string, available: boolean) => ({
  sourceModelId: name.toLowerCase().replaceAll(" ", "-"),
  name,
  vendorLabel: "Anthropic",
  contextTokens: null,
  inputPerMillion: null,
  cachedReadPerMillion: null,
  outputPerMillion: null,
  visionSupport: null,
  reasoningSupport: null,
  parallelAgentSupport: null,
  bestUse: null,
  avoidFor: null,
  benchmarkConfidence: null,
  favourite: false,
  verifiedOn: null,
  availability: available
    ? [{ instanceId: ProviderInstanceId.make("claude"), model: "x", matchedBy: "exact" as const }]
    : [],
});

describe("sortCatalogueRows", () => {
  test("puts available models first, then sorts by name", () => {
    const sorted = sortCatalogueRows([
      entry("Zeta", false),
      entry("Beta", false),
      entry("Alpha", true),
    ]);
    expect(sorted.map((row) => row.name)).toEqual(["Alpha", "Beta", "Zeta"]);
  });
});

describe("filterCatalogueRows", () => {
  const rows = [entry("Claude Sonnet 5", true), entry("Gemini Flash", false)];

  test("matches name case-insensitively", () => {
    expect(filterCatalogueRows(rows, { query: "sonnet", availableOnly: false })).toHaveLength(1);
  });

  test("availableOnly hides catalogue-only models", () => {
    expect(filterCatalogueRows(rows, { query: "", availableOnly: true })).toHaveLength(1);
  });

  test("an empty query returns everything", () => {
    expect(filterCatalogueRows(rows, { query: "", availableOnly: false })).toHaveLength(2);
  });
});

describe("formatModelConfidence", () => {
  test("renders the catalogue's 0-100 percentage without multiplying it", () => {
    expect(formatModelConfidence(98)).toBe("98%");
    expect(formatModelConfidence(null)).toBe("—");
  });
});
