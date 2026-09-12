import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import { HermesSettings } from "@t3tools/contracts";
import { isHostWindows } from "@t3tools/shared/hostProcess";

import {
  buildHermesDiscoveredModelsFromInventory,
  buildHermesDiscoveredModelsFromSessionModelState,
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
  encodeHermesModelChoice,
  getHermesFallbackModels,
  resolveHermesPythonCandidate,
  HERMES_SETUP_MESSAGE,
  mergeHermesDiscoveredModels,
  parseHermesInventoryPayload,
  parseHermesSubProvider,
  resolveHermesAuthStatus,
} from "./HermesProvider.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const HERMES_SESSION_MODEL_STATE = {
  currentModelId: "openai-codex:gpt-5.6-sol",
  availableModels: [
    {
      modelId: "openai-codex:gpt-5.6-sol",
      name: "gpt-5.6-sol",
      description: "Provider: OpenAI Codex • current",
    },
    {
      modelId: "openai-codex:gpt-5.4",
      name: "gpt-5.4",
      description: "Provider: OpenAI Codex",
    },
    {
      modelId: "openai-codex:gpt-5.3-codex",
      name: "gpt-5.3-codex",
      description: "Provider: OpenAI Codex",
    },
    {
      modelId: "openai-codex:gpt-4.1",
      name: "gpt-4.1",
      description: "Provider: OpenAI Codex",
    },
    {
      modelId: "openai-codex:o3",
      name: "o3",
      description: "Provider: OpenAI Codex",
    },
    {
      modelId: "openai-codex:o4-mini",
      name: "o4-mini",
      description: "Provider: OpenAI Codex",
    },
    {
      modelId: "openai-codex:gpt-5.6",
      name: "gpt-5.6",
      description: "Provider: OpenAI Codex",
    },
    {
      modelId: "openai-codex:gpt-5.5",
      name: "gpt-5.5",
      description: "Provider: OpenAI Codex",
    },
    {
      modelId: "openai-codex:codex-mini",
      name: "codex-mini",
      description: "Provider: OpenAI Codex",
    },
  ],
} satisfies EffectAcpSchema.SessionModelState;

describe("parseHermesSubProvider", () => {
  it("strips the current suffix from a Hermes model description", () => {
    expect(parseHermesSubProvider("Provider: OpenAI Codex • current")).toBe("OpenAI Codex");
  });

  it("parses a description without a suffix", () => {
    expect(parseHermesSubProvider("Provider: OpenRouter")).toBe("OpenRouter");
  });

  it("returns undefined when the description is not a provider line", () => {
    expect(parseHermesSubProvider("gpt-5.6-sol")).toBeUndefined();
    expect(parseHermesSubProvider(undefined)).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("resolveHermesPythonCandidate", (it) => {
  for (const platform of ["win32", "linux"] as const) {
    it.effect(`finds the venv python on ${platform}, following a symlink when permitted`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-py-" });
        const venvBin = path.join(root, "venv", "bin");
        const localBin = path.join(root, "local", "bin");
        yield* fs.makeDirectory(venvBin, { recursive: true });
        yield* fs.makeDirectory(localBin, { recursive: true });
        const pythonPath = path.join(venvBin, platform === "win32" ? "python.exe" : "python");
        const hermesReal = path.join(venvBin, "hermes");
        const hermesLink = path.join(localBin, "hermes");
        yield* fs.writeFileString(pythonPath, "");
        yield* fs.writeFileString(hermesReal, "");
        const candidate = yield* fs.symlink(hermesReal, hermesLink).pipe(
          Effect.as(hermesLink),
          Effect.orElseSucceed(() => hermesReal),
        );
        expect(yield* fs.realPath(resolveHermesPythonCandidate(candidate, platform)!)).toBe(
          yield* fs.realPath(pythonPath),
        );
      }),
    );
  }
});

describe("parseHermesInventoryPayload", () => {
  it("parses the root object even when providers contain nested braces", () => {
    const payload = parseHermesInventoryPayload(
      'noise\n{"provider":"openai-codex","model":"gpt-5.6-sol","providers":[{"slug":"gemini","name":"Google","models":["gemini-3.1-pro"]}]}',
    );
    expect(payload?.provider).toBe("openai-codex");
    expect((payload?.providers as { slug: string }[] | undefined)?.[0]?.slug).toBe("gemini");
  });
});

describe("encodeHermesModelChoice", () => {
  it("encodes provider and model the way ACP session/set_model expects", () => {
    expect(encodeHermesModelChoice("OpenAI-Codex", "gpt-5.4")).toBe("openai-codex:gpt-5.4");
    expect(encodeHermesModelChoice("", "gpt-5.4")).toBe("gpt-5.4");
  });
});

describe("buildHermesDiscoveredModelsFromInventory", () => {
  it("flattens every authenticated provider into ACP-shaped slugs", () => {
    const models = buildHermesDiscoveredModelsFromInventory({
      provider: "gemini",
      model: "gemini-3.1-pro",
      providers: [
        { slug: "gemini", name: "Google", models: ["gemini-3.1-pro", "gemini-3-flash"] },
        { slug: "anthropic", name: "Anthropic", models: ["claude-opus-4.6"] },
        { slug: "", name: "skip", models: ["nope"] },
      ],
    });

    expect(models).toEqual([
      {
        slug: "gemini:gemini-3.1-pro",
        name: "gemini-3.1-pro",
        subProvider: "Google",
        isCustom: false,
        isDefault: true,
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "gemini:gemini-3-flash",
        name: "gemini-3-flash",
        subProvider: "Google",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "anthropic:claude-opus-4.6",
        name: "claude-opus-4.6",
        subProvider: "Anthropic",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });
});

describe("mergeHermesDiscoveredModels", () => {
  it("keeps ACP models and adds other inventory providers", () => {
    const merged = mergeHermesDiscoveredModels(
      [
        {
          slug: "openai-codex:gpt-5.4",
          name: "gpt-5.4",
          subProvider: "OpenAI Codex",
          isCustom: false,
          isDefault: true,
          capabilities: { optionDescriptors: [] },
        },
      ],
      [
        {
          slug: "gemini:gemini-3.1-pro",
          name: "gemini-3.1-pro",
          subProvider: "Google",
          isCustom: false,
          isDefault: true,
          capabilities: { optionDescriptors: [] },
        },
        {
          slug: "openai-codex:gpt-5.4",
          name: "gpt-5.4",
          subProvider: "OpenAI Codex",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
      ],
    );

    expect(merged.map((model) => model.slug)).toEqual([
      "gemini:gemini-3.1-pro",
      "openai-codex:gpt-5.4",
    ]);
    expect(merged.find((model) => model.slug === "openai-codex:gpt-5.4")?.isDefault).toBe(true);
    expect(
      merged.find((model) => model.slug === "gemini:gemini-3.1-pro")?.isDefault,
    ).toBeUndefined();
  });
});

describe("buildHermesDiscoveredModelsFromSessionModelState", () => {
  it("maps a real-shaped SessionModelState without fabricating capabilities", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState(HERMES_SESSION_MODEL_STATE);

    expect(models).toHaveLength(9);
    expect(models[0]).toEqual({
      slug: "openai-codex:gpt-5.6-sol",
      name: "gpt-5.6-sol",
      subProvider: "OpenAI Codex",
      isCustom: false,
      isDefault: true,
      capabilities: { optionDescriptors: [] },
    });
    expect(
      models.every((model) => (model.capabilities?.optionDescriptors ?? []).length === 0),
    ).toBe(true);
    expect(models.filter((model) => model.isDefault === true)).toHaveLength(1);
    expect(models.map((model) => model.slug)).toEqual(
      HERMES_SESSION_MODEL_STATE.availableModels.map((model) => model.modelId),
    );
    expect(models.slice(1).every((model) => model.subProvider === "OpenAI Codex")).toBe(true);
    expect(models.slice(1).every((model) => model.isDefault !== true)).toBe(true);
  });

  it("returns an empty list when discovery is missing or empty", () => {
    expect(buildHermesDiscoveredModelsFromSessionModelState(undefined)).toEqual([]);
    expect(
      buildHermesDiscoveredModelsFromSessionModelState({
        currentModelId: "openai-codex:gpt-5.6-sol",
        availableModels: [],
      }),
    ).toEqual([]);
  });
});

describe("resolveHermesAuthStatus", () => {
  it("reports authenticated when a non-terminal provider method is advertised", () => {
    expect(
      resolveHermesAuthStatus({
        authMethods: [{ id: "openai-codex" }, { id: "hermes-setup", type: "terminal" }],
        sessionStarted: false,
      }),
    ).toEqual({ auth: { status: "authenticated" } });
  });

  it("reports authenticated when session/new succeeded even without auth methods", () => {
    expect(
      resolveHermesAuthStatus({
        authMethods: [],
        sessionStarted: true,
      }),
    ).toEqual({ auth: { status: "authenticated" } });
  });

  it("reports unauthenticated when only hermes-setup is advertised", () => {
    expect(
      resolveHermesAuthStatus({
        authMethods: [{ id: "hermes-setup", type: "terminal" }],
        sessionStarted: true,
      }),
    ).toEqual({
      auth: { status: "unauthenticated" },
      message: HERMES_SETUP_MESSAGE,
    });
  });
});

describe("getHermesFallbackModels", () => {
  it("does not fabricate a built-in model when discovery is empty", () => {
    expect(getHermesFallbackModels(decodeHermesSettings({}))).toEqual([]);
    expect(
      getHermesFallbackModels(decodeHermesSettings({ customModels: ["openrouter:custom"] })),
    ).toEqual([
      {
        slug: "openrouter:custom",
        name: "openrouter:custom",
        isCustom: true,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });
});

describe("buildInitialHermesProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
      expect(snapshot.models).toEqual([]);
    }),
  );

  it.effect("returns a disabled snapshot by default — Hermes is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(decodeHermesSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Hermes");
    }),
  );
});

it.layer(NodeServices.layer)("checkHermesProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkHermesProviderStatus(
        decodeHermesSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/hermes-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("falls back to custom models with a warning when ACP discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const isWindows = yield* isHostWindows;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-version-" });
          const hermesPath = path.join(dir, isWindows ? "hermes.cmd" : "hermes");
          yield* fs.writeFileString(
            hermesPath,
            isWindows
              ? ["@echo off", "echo hermes-agent 0.19.0", "exit /b 0", ""].join("\r\n")
              : ["#!/bin/sh", 'printf "hermes-agent 0.19.0\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(hermesPath, 0o755);

          return yield* checkHermesProviderStatus(
            decodeHermesSettings({
              enabled: true,
              binaryPath: hermesPath,
              customModels: ["openrouter:custom"],
            }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["openrouter:custom"]);
      expect(snapshot.models.every((model) => model.isCustom)).toBe(true);
      expect(snapshot.message).toContain("ACP");
    }),
  );
});
