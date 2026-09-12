import { assert, describe, it } from "@effect/vitest";
import { AntigravitySettings } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { checkAntigravityProviderStatus, orderAntigravityModels } from "./AntigravityProvider.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);
const encoder = new TextEncoder();

function mockHandle(result: {
  readonly stdout: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    readonly stdout: string;
    readonly stderr?: string;
    readonly code?: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const input = command as unknown as { readonly args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(input.args)));
    }),
  );
}

const successfulProbeLayer = mockSpawnerLayer((args) => {
  if (args.includes("--version")) return { stdout: "1.1.26" };
  if (args.includes("--help")) {
    return { stdout: "--input-format text, stream-json\n--output-format stream-json" };
  }
  return {
    stdout: [
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "other-model\tOther Model",
    ].join("\n"),
    stderr: "Fetching available models...",
  };
});

describe("Antigravity provider health", () => {
  it("puts the preferred discovered default first without dropping models", () => {
    const models = orderAntigravityModels([
      { slug: "other", name: "Other", isCustom: false, capabilities: { optionDescriptors: [] } },
      {
        slug: "gemini-3.8-flash-high",
        name: "High",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "gemini-3.8-flash-medium",
        name: "Medium",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
    assert.deepEqual(
      models.map((model) => model.slug),
      ["gemini-3.8-flash-medium", "gemini-3.8-flash-high", "other"],
    );
  });

  it.effect("marks a non-empty capability-probed model list authenticated and ready", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(decodeSettings({ enabled: true }));
      assert.strictEqual(snapshot.status, "ready");
      assert.strictEqual(snapshot.auth.status, "authenticated");
      assert.strictEqual(snapshot.badgeLabel, "Experimental");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["gemini-3.8-flash-medium", "gemini-3.8-flash-high", "other-model"],
      );
    }).pipe(Effect.provide(successfulProbeLayer)),
  );

  it.effect("uses hidden custom models only when discovery has no successful catalogue", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(
        decodeSettings({ enabled: true, customModels: ["custom-fallback"] }),
      );
      assert.notInclude(
        snapshot.models.map((model) => model.slug),
        "custom-fallback",
      );
    }).pipe(Effect.provide(successfulProbeLayer)),
  );

  it.effect("rejects a CLI without stream-json capabilities", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(decodeSettings({ enabled: true }));
      assert.strictEqual(snapshot.status, "error");
      assert.match(snapshot.message ?? "", /stream-json/i);
    }).pipe(
      Effect.provide(
        mockSpawnerLayer((args) =>
          args.includes("--version") ? { stdout: "1.1.26" } : { stdout: "plain text only" },
        ),
      ),
    ),
  );

  it.effect("reports an installed but unauthenticated CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(decodeSettings({ enabled: true }));
      assert.strictEqual(snapshot.status, "error");
      assert.strictEqual(snapshot.auth.status, "unauthenticated");
      assert.match(snapshot.message ?? "", /run `agy`/i);
    }).pipe(
      Effect.provide(
        mockSpawnerLayer((args) => {
          if (args.includes("--version")) return { stdout: "1.1.26" };
          if (args.includes("--help")) {
            return { stdout: "--input-format stream-json\n--output-format stream-json" };
          }
          return { stdout: "", stderr: "authentication required", code: 1 };
        }),
      ),
    ),
  );

  it.effect("retains the prior successful catalogue when refresh fails", () =>
    Effect.gen(function* () {
      const cached = [
        {
          slug: "cached-model",
          name: "Cached Model",
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        },
      ];
      const snapshot = yield* checkAntigravityProviderStatus(
        decodeSettings({ enabled: true }),
        process.env,
        () => cached,
      );
      assert.strictEqual(snapshot.status, "error");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["cached-model"],
      );
    }).pipe(
      Effect.provide(
        mockSpawnerLayer((args) => {
          if (args.includes("--version")) return { stdout: "1.1.26" };
          if (args.includes("--help")) {
            return { stdout: "--input-format stream-json\n--output-format stream-json" };
          }
          return { stdout: "", stderr: "temporary failure", code: 1 };
        }),
      ),
    ),
  );

  it.effect("reports a missing binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(decodeSettings({ enabled: true }));
      assert.isFalse(snapshot.installed);
      assert.match(snapshot.message ?? "", /not installed|not on PATH/i);
    }).pipe(
      Effect.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                description: "agy missing",
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.live("reports a probe timeout", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(
        decodeSettings({ enabled: true }),
        process.env,
        () => undefined,
        1,
      );
      assert.strictEqual(snapshot.status, "error");
      assert.match(snapshot.message ?? "", /timed out/i);
    }).pipe(
      Effect.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.never),
        ),
      ),
    ),
  );
});
