import { describe, expect, it } from "vite-plus/test";

import {
  formatModelNameWithSubProvider,
  getDisplayModelName,
  getModelSubProviderLabel,
  getTriggerDisplayModelLabel,
  type ModelEsque,
} from "./providerIconUtils";

function model(input: Partial<ModelEsque> & Pick<ModelEsque, "slug" | "name">): ModelEsque {
  return input;
}

describe("OpenCode sub-provider model labels", () => {
  it("keeps the upstream provider out of the stripped display name", () => {
    expect(
      getDisplayModelName(
        model({ slug: "xai/grok-4.6", name: "xAI Grok 4.6", subProvider: "xAI" }),
      ),
    ).toBe("Grok 4.6");
  });

  it("prefixes the picker/trigger label with the upstream provider", () => {
    expect(
      getTriggerDisplayModelLabel(
        model({ slug: "xai/grok-4.6", name: "Grok 4.6", subProvider: "xAI" }),
      ),
    ).toBe("xAI / Grok 4.6");
    expect(
      formatModelNameWithSubProvider({
        name: "Deepseek V4 Pro",
        subProvider: "OpenCode Go",
      }),
    ).toBe("OpenCode Go / Deepseek V4 Pro");
  });

  it("omits a blank sub-provider prefix", () => {
    expect(getModelSubProviderLabel({ subProvider: "  " })).toBeUndefined();
    expect(getTriggerDisplayModelLabel(model({ slug: "gpt-5", name: "GPT-5" }))).toBe("GPT-5");
  });
});
