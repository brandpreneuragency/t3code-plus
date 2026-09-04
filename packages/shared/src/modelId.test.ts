import { describe, expect, it } from "vite-plus/test";

import { matchCatalogueEntry, normalizeModelId, stripVendorPrefix } from "./modelId.ts";

describe("normalizeModelId", () => {
  const cases = [
    ["claude-opus-4.6", "claude-opus-4-6"],
    ["claude-opus-4-6-20251117", "claude-opus-4-6"],
    ["claude-sonnet-5.0", "claude-sonnet-5"],
    ["claude-sonnet-5-0", "claude-sonnet-5"],
    ["claude-sonnet-5", "claude-sonnet-5"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["claude-haiku-4.5", "claude-haiku-4-5"],
    ["gemini-3.5-flash", "gemini-3-5-flash"],
    ["  Claude-Fable-5  ", "claude-fable-5"],
    ["gpt--5--mini", "gpt-5-mini"],
    ["", ""],
  ] as const;

  for (const [input, expected] of cases) {
    it(`normalizes ${input} to ${expected}`, () => {
      expect(normalizeModelId(input)).toBe(expected);
    });
  }

  it("does not merge adjacent versions", () => {
    expect(normalizeModelId("claude-opus-4-6")).not.toBe(normalizeModelId("claude-opus-4-8"));
  });

  it("does not strip a non-minor trailing zero", () => {
    expect(normalizeModelId("gpt-oss-120b")).toBe("gpt-oss-120b");
  });
});

describe("stripVendorPrefix", () => {
  const cases = [
    ["openai/gpt-5.6-luna", "gpt-5.6-luna"],
    ["x-ai/grok-4.5", "grok-4.5"],
    ["grok-4.5", "grok-4.5"],
  ] as const;

  for (const [input, expected] of cases) {
    it(`strips ${input} to ${expected}`, () => {
      expect(stripVendorPrefix(input)).toBe(expected);
    });
  }
});

describe("matchCatalogueEntry", () => {
  const providerModels = [
    { instanceId: "claude", slug: "claude-sonnet-5" },
    { instanceId: "claude", slug: "claude-opus-4.6" },
    { instanceId: "codex", slug: "gpt-5.6-luna" },
  ];

  it("matches an identical id as exact", () => {
    const matches = matchCatalogueEntry({
      sourceModelId: "claude-sonnet-5",
      aliases: [],
      providerModels,
    });
    expect(matches).toEqual([
      { instanceId: "claude", model: "claude-sonnet-5", matchedBy: "exact" },
    ]);
  });

  it("matches across dot and dash spellings as normalized", () => {
    const matches = matchCatalogueEntry({
      sourceModelId: "claude-opus-4-6-20251117",
      aliases: [],
      providerModels,
    });
    expect(matches).toEqual([
      { instanceId: "claude", model: "claude-opus-4.6", matchedBy: "normalized" },
    ]);
  });

  it("falls back to an alias with its vendor prefix stripped", () => {
    const matches = matchCatalogueEntry({
      sourceModelId: "luna-internal-name",
      aliases: ["openai/gpt-5.6-luna"],
      providerModels,
    });
    expect(matches).toEqual([{ instanceId: "codex", model: "gpt-5.6-luna", matchedBy: "alias" }]);
  });

  it("returns every matching provider model, not just the first", () => {
    const matches = matchCatalogueEntry({
      sourceModelId: "claude-sonnet-5",
      aliases: [],
      providerModels: [
        { instanceId: "claude", slug: "claude-sonnet-5" },
        { instanceId: "claude-work", slug: "claude-sonnet-5.0" },
      ],
    });
    expect(matches).toHaveLength(2);
    expect(matches[1]).toEqual({
      instanceId: "claude-work",
      model: "claude-sonnet-5.0",
      matchedBy: "normalized",
    });
  });

  it("returns an empty array for a catalogue-only model", () => {
    expect(
      matchCatalogueEntry({
        sourceModelId: "some-model-nobody-has",
        aliases: [],
        providerModels,
      }),
    ).toEqual([]);
  });

  it("never matches on empty ids", () => {
    expect(
      matchCatalogueEntry({
        sourceModelId: "",
        aliases: [],
        providerModels: [{ instanceId: "x", slug: "" }],
      }),
    ).toEqual([]);
  });
});
