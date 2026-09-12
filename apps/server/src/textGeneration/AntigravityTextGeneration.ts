import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TextGeneration from "./TextGeneration.ts";

const unsupported = (operation: TextGenerationError["operation"]) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Antigravity is only used for explicit thread turns in T3 Code.",
    }),
  );

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(() =>
  Effect.succeed({
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  } satisfies TextGeneration.TextGeneration["Service"]),
);
