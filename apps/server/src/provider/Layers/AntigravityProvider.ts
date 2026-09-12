import {
  type AntigravitySettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  ANTIGRAVITY_DEFAULT_BINARY,
  antigravityHelpArgs,
  antigravityListModelsArgs,
  antigravityVersionArgs,
} from "../antigravityLaunchArgs.ts";
import {
  antigravityAuthenticationRequired,
  antigravityErrorMessage,
  antigravitySupportsStreamJson,
  parseAntigravityModels,
} from "../antigravityCliParse.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Antigravity",
  badgeLabel: "Experimental",
  showInteractionModeToggle: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export const ANTIGRAVITY_DEFAULT_MODEL_PREFERENCE = [
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-high",
  "gemini-3.7-flash-medium",
] as const;

const PROBE_TIMEOUT_MS = 60_000;

function modelsFromSettings(
  settings: AntigravitySettings,
  discovered: ReadonlyArray<ServerProviderModel>,
) {
  const ordered = orderAntigravityModels(discovered);
  return ordered.length > 0
    ? ordered
    : providerModelsFromSettings([], settings.customModels ?? [], EMPTY_CAPABILITIES);
}

export function orderAntigravityModels(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const rank = (model: ServerProviderModel) => {
    const index = ANTIGRAVITY_DEFAULT_MODEL_PREFERENCE.indexOf(
      model.slug as (typeof ANTIGRAVITY_DEFAULT_MODEL_PREFERENCE)[number],
    );
    return index < 0 ? ANTIGRAVITY_DEFAULT_MODEL_PREFERENCE.length : index;
  };
  return [...models].sort((left, right) => rank(left) - rank(right));
}

const runAntigravityCommand = (
  settings: AntigravitySettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const binary = settings.binaryPath || ANTIGRAVITY_DEFAULT_BINARY;
    const resolved = yield* resolveSpawnCommand(binary, [...args], { env: environment });
    return yield* spawnAndCollect(
      binary,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        shell: resolved.shell,
      }),
    );
  });

function errorSnapshot(input: {
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly version: string | null;
  readonly installed?: boolean;
  readonly auth?: "unknown" | "unauthenticated";
  readonly message: string;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt: input.checkedAt,
    models: input.models,
    probe: {
      installed: input.installed ?? true,
      version: input.version,
      status: "error",
      auth: { status: input.auth ?? "unknown" },
      message: input.message,
    },
  });
}

export function buildInitialAntigravityProviderSnapshot(
  settings: AntigravitySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromSettings(settings, []),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Antigravity CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Antigravity is disabled in T3 Code settings.",
          },
    });
  });
}

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    settings: AntigravitySettings,
    environment: NodeJS.ProcessEnv = process.env,
    getCachedModels: () => ReadonlyArray<ServerProviderModel> | undefined = () => undefined,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    if (!settings.enabled) {
      return yield* buildInitialAntigravityProviderSnapshot(settings);
    }

    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const retainedModels = () => modelsFromSettings(settings, getCachedModels() ?? []);
    const versionResult = yield* runAntigravityCommand(
      settings,
      antigravityVersionArgs(),
      environment,
    ).pipe(Effect.timeoutOption(Duration.millis(probeTimeoutMs)), Effect.result);

    if (Result.isFailure(versionResult)) {
      return errorSnapshot({
        checkedAt,
        models: retainedModels(),
        version: null,
        installed: !isCommandMissingCause(versionResult.failure),
        message: isCommandMissingCause(versionResult.failure)
          ? "Antigravity CLI (`agy`) is not installed or not on PATH."
          : "Failed to execute Antigravity CLI health check.",
      });
    }
    if (Option.isNone(versionResult.success)) {
      return errorSnapshot({
        checkedAt,
        models: retainedModels(),
        version: null,
        message: "Antigravity CLI timed out while running `--version`.",
      });
    }

    const versionOutput = versionResult.success.value;
    const versionText = `${versionOutput.stdout}\n${versionOutput.stderr}`;
    const version = parseGenericCliVersion(versionText);
    if (versionOutput.code !== 0) {
      return errorSnapshot({
        checkedAt,
        models: retainedModels(),
        version,
        auth: antigravityAuthenticationRequired(versionText) ? "unauthenticated" : "unknown",
        message:
          antigravityErrorMessage(versionText) ??
          "Antigravity CLI is installed but failed to run `--version`.",
      });
    }

    const helpResult = yield* runAntigravityCommand(
      settings,
      antigravityHelpArgs(),
      environment,
    ).pipe(Effect.timeoutOption(Duration.millis(probeTimeoutMs)), Effect.result);
    if (Result.isFailure(helpResult) || Option.isNone(helpResult.success)) {
      return errorSnapshot({
        checkedAt,
        models: retainedModels(),
        version,
        message: Result.isSuccess(helpResult)
          ? "Antigravity CLI timed out while running `--help`."
          : "Failed to probe Antigravity CLI stream-json capabilities.",
      });
    }

    const helpOutput = helpResult.success.value;
    const helpText = `${helpOutput.stdout}\n${helpOutput.stderr}`;
    if (helpOutput.code !== 0 || !antigravitySupportsStreamJson(helpText)) {
      return errorSnapshot({
        checkedAt,
        models: retainedModels(),
        version,
        message: "Antigravity CLI does not advertise required stream-json input/output support.",
      });
    }

    const modelsResult = yield* runAntigravityCommand(
      settings,
      antigravityListModelsArgs(),
      environment,
    ).pipe(Effect.timeoutOption(Duration.millis(probeTimeoutMs)), Effect.result);
    if (Result.isFailure(modelsResult) || Option.isNone(modelsResult.success)) {
      return errorSnapshot({
        checkedAt,
        models: retainedModels(),
        version,
        message: Result.isSuccess(modelsResult)
          ? "Antigravity CLI timed out while running `agy models`."
          : "Failed to query Antigravity models.",
      });
    }

    const modelsOutput = modelsResult.success.value;
    const modelsText = `${modelsOutput.stdout}\n${modelsOutput.stderr}`;
    const unauthenticated = antigravityAuthenticationRequired(modelsText);
    const discovered = parseAntigravityModels(modelsOutput.stdout).map((model) => ({
      ...model,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    }));

    if (modelsOutput.code !== 0 || unauthenticated || discovered.length === 0) {
      return errorSnapshot({
        checkedAt,
        models: retainedModels(),
        version,
        auth: unauthenticated ? "unauthenticated" : "unknown",
        message: unauthenticated
          ? "Antigravity CLI is installed but not authenticated. Run `agy` in a terminal, sign in, then refresh provider status."
          : (antigravityErrorMessage(modelsText) ??
            "Antigravity returned no models. Run `agy` in a terminal and complete sign-in."),
      });
    }

    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelsFromSettings(settings, discovered),
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated" },
      },
    });
  },
);
