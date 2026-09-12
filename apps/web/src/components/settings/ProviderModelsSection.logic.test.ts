import type { ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupModelsBySubProvider,
  nextHiddenModelsForProviderVisibilityToggle,
} from "./ProviderModelsSection.logic";

function model(
  slug: string,
  options: { isCustom?: boolean; subProvider?: string } = {},
): Pick<ServerProviderModel, "slug" | "isCustom" | "subProvider"> {
  return {
    slug,
    isCustom: options.isCustom === true,
    ...(options.subProvider ? { subProvider: options.subProvider } : {}),
  };
}

describe("nextHiddenModelsForProviderVisibilityToggle", () => {
  it("hides every built-in model when any are still visible", () => {
    expect(
      nextHiddenModelsForProviderVisibilityToggle({
        models: [model("a"), model("b"), model("custom", { isCustom: true })],
        hiddenModels: ["a", "stale"],
      }),
    ).toEqual(["a", "stale", "b"]);
  });

  it("shows every built-in model when all of them are hidden", () => {
    expect(
      nextHiddenModelsForProviderVisibilityToggle({
        models: [model("a"), model("b"), model("custom", { isCustom: true })],
        hiddenModels: ["stale", "a", "b"],
      }),
    ).toEqual(["stale"]);
  });

  it("leaves hiddenModels unchanged when there are no built-in models", () => {
    expect(
      nextHiddenModelsForProviderVisibilityToggle({
        models: [model("custom", { isCustom: true })],
        hiddenModels: ["stale"],
      }),
    ).toEqual(["stale"]);
  });
});

describe("groupModelsBySubProvider", () => {
  it("keeps a single unlabeled list when no model has an upstream provider", () => {
    expect(
      groupModelsBySubProvider([model("gpt-5"), model("extra", { isCustom: true })]).map(
        (group) => ({
          label: group.label,
          slugs: group.models.map((item) => item.slug),
        }),
      ),
    ).toEqual([{ label: null, slugs: ["gpt-5", "extra"] }]);
  });

  it("groups OpenCode models by upstream provider and parks custom models last", () => {
    expect(
      groupModelsBySubProvider([
        model("opencode-go/deepseek", { subProvider: "OpenCode Go" }),
        model("xai/grok", { subProvider: "xAI" }),
        model("opencode-go/kimi", { subProvider: "OpenCode Go" }),
        model("local-custom", { isCustom: true }),
      ]).map((group) => ({
        label: group.label,
        slugs: group.models.map((item) => item.slug),
      })),
    ).toEqual([
      { label: "OpenCode Go", slugs: ["opencode-go/deepseek", "opencode-go/kimi"] },
      { label: "xAI", slugs: ["xai/grok"] },
      { label: "Custom", slugs: ["local-custom"] },
    ]);
  });
});
