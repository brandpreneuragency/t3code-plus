import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CommandCodeSettings } from "@t3tools/contracts";

import { buildInitialCommandCodeProviderSnapshot } from "./CommandCodeProvider.ts";
import { parseCommandCodeResume } from "./CommandCodeAdapter.ts";

const decodeCommandCodeSettings = Schema.decodeSync(CommandCodeSettings);

describe("buildInitialCommandCodeProviderSnapshot", () => {
  it.effect("stays disabled until the user opts in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCommandCodeProviderSnapshot(
        decodeCommandCodeSettings({}),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.displayName).toBe("Command Code");
      expect(snapshot.showInteractionModeToggle).toBe(true);
      expect(snapshot.message).toBe("Command Code is disabled in T3 Code settings.");
    }),
  );
});

describe("parseCommandCodeResume", () => {
  it("accepts a v1 session id and rejects anything else", () => {
    expect(parseCommandCodeResume({ schemaVersion: 1, sessionId: "  abc  " })).toEqual({
      sessionId: "abc",
    });
    expect(parseCommandCodeResume({ schemaVersion: 2, sessionId: "abc" })).toBeUndefined();
    expect(parseCommandCodeResume({ schemaVersion: 1, sessionId: "" })).toBeUndefined();
    expect(parseCommandCodeResume(null)).toBeUndefined();
  });
});
