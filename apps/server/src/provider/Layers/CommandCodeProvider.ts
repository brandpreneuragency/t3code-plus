import {
  type CommandCodeSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  commandCodeListModelsArgs,
  commandCodeStatusArgs,
  commandCodeVersionArgs,
} from "../commandCodeLaunchArgs.ts";
import {
  messageForCommandCodeExitCode,
  parseCommandCodeListModels,
  parseCommandCodeStatus,
} from "../commandCodeCliParse.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const COMMAND_CODE_PRESENTATION = {
  displayName: "Command Code",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 60_000;
const STATUS_PROBE_TIMEOUT_MS = 60_000;
const LIST_MODELS_TIMEOUT_MS = 60_000;

const COMMAND_CODE_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "deepseek/deepseek-v4-flash",
    name: "deepseek/deepseek-v4-flash",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const runCommandCodeCommand = (
  commandCodeSettings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = commandCodeSettings.binaryPath || "command-code";
    const spawnCommand = yield* resolveSpawnCommand(command, [...args], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

function commandCodeModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = COMMAND_CODE_FALLBACK_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discovered, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialCommandCodeProviderSnapshot(
  commandCodeSettings: CommandCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = commandCodeModelsFromSettings(commandCodeSettings.customModels);

    if (!commandCodeSettings.enabled) {
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Command Code is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COMMAND_CODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Command Code CLI availability...",
      },
    });
  });
}

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    commandCodeSettings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = commandCodeModelsFromSettings(commandCodeSettings.customModels);

    if (!commandCodeSettings.enabled) {
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Command Code is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runCommandCodeCommand(
      commandCodeSettings,
      commandCodeVersionArgs(),
      environment,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Command Code CLI health check failed.", {
        errorTag: error._tag,
      });
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Command Code CLI (`command-code`) is not installed or not on PATH."
            : "Failed to execute Command Code CLI health check.",
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `Command Code CLI timed out after ${VERSION_PROBE_TIMEOUT_MS}ms while running --version.`,
        },
      });
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      const exitMessage = messageForCommandCodeExitCode(versionOutput.code);
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: versionOutput.code === 3 ? { status: "unauthenticated" } : { status: "unknown" },
          message: exitMessage ?? "Command Code CLI is installed but failed to run `--version`.",
        },
      });
    }

    const statusResult = yield* runCommandCodeCommand(
      commandCodeSettings,
      commandCodeStatusArgs(),
      environment,
    ).pipe(Effect.timeoutOption(STATUS_PROBE_TIMEOUT_MS), Effect.result);

    let authStatus: "authenticated" | "unauthenticated" | "unknown" = "unknown";
    let authMessage: string | undefined;
    if (Result.isSuccess(statusResult) && Option.isSome(statusResult.success)) {
      const statusOutput = statusResult.success.value;
      if (statusOutput.code === 3) {
        authStatus = "unauthenticated";
        authMessage = messageForCommandCodeExitCode(3);
      } else if (statusOutput.code === 0) {
        const parsed = parseCommandCodeStatus(`${statusOutput.stdout}\n${statusOutput.stderr}`);
        if (parsed.authenticated === true) authStatus = "authenticated";
        if (parsed.authenticated === false) {
          authStatus = "unauthenticated";
          authMessage = messageForCommandCodeExitCode(3);
        }
      }
    }

    const modelsResult = yield* runCommandCodeCommand(
      commandCodeSettings,
      commandCodeListModelsArgs(),
      environment,
    ).pipe(Effect.timeoutOption(LIST_MODELS_TIMEOUT_MS), Effect.result);

    const discoveredModels =
      Result.isSuccess(modelsResult) && Option.isSome(modelsResult.success)
        ? parseCommandCodeListModels(
            `${modelsResult.success.value.stdout}\n${modelsResult.success.value.stderr}`,
          ).map((model) => ({
            slug: model.slug,
            name: model.name,
            isCustom: false,
            capabilities: EMPTY_CAPABILITIES,
          }))
        : [];

    const models =
      discoveredModels.length > 0
        ? commandCodeModelsFromSettings(commandCodeSettings.customModels, discoveredModels)
        : fallbackModels;

    const ready = authStatus !== "unauthenticated";
    return buildServerProvider({
      presentation: COMMAND_CODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: ready ? "ready" : "error",
        auth: { status: authStatus },
        ...(authMessage ? { message: authMessage } : {}),
      },
    });
  },
);

export const enrichCommandCodeSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Command Code version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
  );
