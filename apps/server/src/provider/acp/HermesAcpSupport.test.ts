import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import { applyHermesAcpModelSelection, buildHermesAcpSpawnInput } from "./HermesAcpSupport.ts";

describe("buildHermesAcpSpawnInput", () => {
  it("defaults the binary to hermes with the acp subcommand", () => {
    expect(buildHermesAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses settings.binaryPath and passes env through", () => {
    const spawn = buildHermesAcpSpawnInput(
      { binaryPath: "/usr/local/bin/hermes" },
      "/tmp/project",
      { OPENAI_API_KEY: "secret" },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        OPENAI_API_KEY: "secret",
      },
    });
  });
});

describe("applyHermesAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{ modelId: string; meta?: unknown }> = [];
    const runtime = {
      setSessionModel: (modelId: string, meta?: unknown) =>
        Effect.gen(function* () {
          modelCalls.push(meta === undefined ? { modelId } : { modelId, meta });
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openai-codex:gpt-5.6-sol",
        requestedModelId: "openai-codex:gpt-5.4",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "openai-codex:gpt-5.4" }]);
      expect(result).toBe("openai-codex:gpt-5.4");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openai-codex:gpt-5.6-sol",
        requestedModelId: "openai-codex:gpt-5.6-sol",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openai-codex:gpt-5.6-sol");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openai-codex:gpt-5.6-sol",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openai-codex:gpt-5.6-sol");
    }),
  );

  it.effect("does not send _meta on session/set_model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openai-codex:gpt-5.6-sol",
        requestedModelId: "openai-codex:gpt-5.4",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls[0]).toEqual({ modelId: "openai-codex:gpt-5.4" });
      expect("meta" in (modelCalls[0] ?? {})).toBe(false);
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openai-codex:gpt-5.6-sol",
          requestedModelId: "openai-codex:gpt-5.4",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
