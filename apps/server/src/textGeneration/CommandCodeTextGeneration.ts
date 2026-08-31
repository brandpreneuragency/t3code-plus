import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TextGeneration from "./TextGeneration.ts";

const unsupported = (operation: TextGenerationError["operation"]) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Command Code does not generate git or title text in T3 Code yet.",
    }),
  );

export const makeCommandCodeTextGeneration = Effect.fn("makeCommandCodeTextGeneration")(
  function* () {
    return {
      generateCommitMessage: () => unsupported("generateCommitMessage"),
      generatePrContent: () => unsupported("generatePrContent"),
      generateBranchName: () => unsupported("generateBranchName"),
      generateThreadTitle: () => unsupported("generateThreadTitle"),
    } satisfies TextGeneration.TextGeneration["Service"];
  },
);
