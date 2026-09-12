// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  type HermesSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeHermesAcpRuntime } from "../acp/HermesAcpSupport.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 12_000;
const HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;
const HERMES_INVENTORY_DISCOVERY_TIMEOUT_MS = 45_000;

const HERMES_INVENTORY_SCRIPT = `import json
from hermes_cli.inventory import build_models_payload, load_picker_context
payload = build_models_payload(load_picker_context(), explicit_only=False)
print(json.dumps({
  "provider": payload.get("provider"),
  "model": payload.get("model"),
  "providers": [
    {"slug": row.get("slug"), "name": row.get("name"), "models": row.get("models") or []}
    for row in payload.get("providers") or []
  ],
}))
`;

export const HERMES_SETUP_MESSAGE = "Run `hermes setup` on the host to configure a provider.";

const HERMES_ACP_DISCOVERY_FAILED_MESSAGE =
  "Hermes CLI is installed but ACP startup failed. Run `hermes setup` on the host if a provider is not configured.";
const HERMES_ACP_DISCOVERY_EMPTY_MESSAGE =
  "Hermes ACP model discovery returned no built-in models.";

const HERMES_SUB_PROVIDER_DESCRIPTION = /^Provider: (.+?)(?: •.*)?$/;

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getHermesFallbackModels(hermesSettings);

    if (!hermesSettings.enabled) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Hermes CLI availability...",
      },
    });
  });
}

export function getHermesFallbackModels(
  hermesSettings: Pick<HermesSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], hermesSettings.customModels, EMPTY_CAPABILITIES);
}

export function parseHermesSubProvider(description: string | null | undefined): string | undefined {
  const match = description?.trim().match(HERMES_SUB_PROVIDER_DESCRIPTION);
  const subProvider = match?.[1]?.trim();
  return subProvider && subProvider.length > 0 ? subProvider : undefined;
}

export function encodeHermesModelChoice(provider: string, model: string): string {
  const rawModel = model.trim();
  if (!rawModel) {
    return "";
  }
  const rawProvider = provider.trim().toLowerCase();
  return rawProvider ? `${rawProvider}:${rawModel}` : rawModel;
}

export interface HermesInventoryProviderRow {
  readonly slug?: unknown;
  readonly name?: unknown;
  readonly models?: unknown;
}

export interface HermesInventoryPayload {
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly providers?: unknown;
}

export function buildHermesDiscoveredModelsFromInventory(
  payload: HermesInventoryPayload | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  const currentSlug = encodeHermesModelChoice(
    typeof payload?.provider === "string" ? payload.provider : "",
    typeof payload?.model === "string" ? payload.model : "",
  );
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  for (const row of providers) {
    if (row === null || typeof row !== "object") {
      continue;
    }
    const providerRow = row as HermesInventoryProviderRow;
    const providerSlug = typeof providerRow.slug === "string" ? providerRow.slug.trim() : "";
    if (!providerSlug) {
      continue;
    }
    const label =
      typeof providerRow.name === "string" && providerRow.name.trim().length > 0
        ? providerRow.name.trim()
        : providerSlug;
    const modelIds = Array.isArray(providerRow.models) ? providerRow.models : [];
    for (const modelId of modelIds) {
      if (typeof modelId !== "string") {
        continue;
      }
      const trimmedModelId = modelId.trim();
      const slug = encodeHermesModelChoice(providerSlug, trimmedModelId);
      if (!slug || seen.has(slug)) {
        continue;
      }
      seen.add(slug);
      models.push({
        slug,
        name: trimmedModelId,
        subProvider: label,
        isCustom: false,
        ...(slug === currentSlug ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      });
    }
  }

  return models;
}

export function mergeHermesDiscoveredModels(
  acpModels: ReadonlyArray<ServerProviderModel>,
  inventoryModels: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const bySlug = new Map<string, ServerProviderModel>();
  for (const model of inventoryModels) {
    bySlug.set(model.slug, model);
  }
  for (const model of acpModels) {
    const existing = bySlug.get(model.slug);
    bySlug.set(
      model.slug,
      existing
        ? {
            ...existing,
            ...model,
            subProvider: model.subProvider ?? existing.subProvider,
          }
        : model,
    );
  }

  const defaultSlug =
    acpModels.find((model) => model.isDefault === true)?.slug ??
    inventoryModels.find((model) => model.isDefault === true)?.slug;
  if (!defaultSlug) {
    return [...bySlug.values()];
  }

  return [...bySlug.values()].map((model) => {
    const { isDefault: _isDefault, ...rest } = model;
    return model.slug === defaultSlug ? { ...rest, isDefault: true } : rest;
  });
}

function isHermesTerminalAuthMethod(method: {
  readonly id: string;
  readonly type?: string;
}): boolean {
  return method.type === "terminal" || method.id === "hermes-setup";
}

function authMethodType(method: EffectAcpSchema.AuthMethod): string | undefined {
  return "type" in method && typeof method.type === "string" ? method.type : undefined;
}

export function readHermesAuthMethods(
  initializeResult: EffectAcpSchema.InitializeResponse | null | undefined,
): ReadonlyArray<{ readonly id: string; readonly type?: string }> {
  const methods = initializeResult?.authMethods ?? [];
  return methods.flatMap((method) => {
    const id = method.id.trim();
    if (!id) {
      return [];
    }
    const type = authMethodType(method);
    return [
      {
        id,
        ...(type ? { type } : {}),
      },
    ];
  });
}

export function resolveHermesAuthStatus(input: {
  readonly authMethods: ReadonlyArray<{ readonly id: string; readonly type?: string }>;
  readonly sessionStarted: boolean;
}): {
  readonly auth: ServerProviderAuth;
  readonly message?: string;
} {
  const hasNonTerminal = input.authMethods.some((method) => !isHermesTerminalAuthMethod(method));
  const onlyTerminalSetup =
    input.authMethods.length > 0 && input.authMethods.every(isHermesTerminalAuthMethod);

  if (onlyTerminalSetup) {
    return {
      auth: { status: "unauthenticated" },
      message: HERMES_SETUP_MESSAGE,
    };
  }
  if (hasNonTerminal || input.sessionStarted) {
    return { auth: { status: "authenticated" } };
  }
  return { auth: { status: "unknown" } };
}

export function buildHermesDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const currentModelId = modelState.currentModelId.trim();
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = model.modelId.trim();
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      const subProvider = parseHermesSubProvider(model.description);
      return {
        slug,
        name: model.name.trim() || slug,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        ...(slug === currentModelId ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

interface HermesAcpDiscovery {
  readonly initializeResult: EffectAcpSchema.InitializeResponse | undefined;
  readonly sessionStarted: boolean;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

const discoverHermesViaAcp = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    let capturedInitialize: EffectAcpSchema.InitializeResponse | undefined;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeHermesAcpRuntime({
      hermesSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      requestLogger: (event) =>
        Effect.sync(() => {
          if (event.method === "initialize" && event.status === "succeeded") {
            capturedInitialize = event.result as EffectAcpSchema.InitializeResponse | undefined;
          }
        }),
    });
    const started = yield* acp.start().pipe(Effect.result);
    if (Result.isFailure(started)) {
      return {
        initializeResult: capturedInitialize,
        sessionStarted: false,
        models: [],
      } satisfies HermesAcpDiscovery;
    }
    return {
      initializeResult: started.success.initializeResult,
      sessionStarted: true,
      models: buildHermesDiscoveredModelsFromSessionModelState(
        started.success.sessionSetupResult.models,
      ),
    } satisfies HermesAcpDiscovery;
  }).pipe(Effect.scoped);

export function parseHermesInventoryPayload(stdout: string): HermesInventoryPayload | undefined {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed.slice(start)) as HermesInventoryPayload;
  } catch {
    return undefined;
  }
}

export function findHermesBinaryOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    try {
      return NodeFS.existsSync(trimmed) ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? [trimmed, `${trimmed}.exe`, `${trimmed}.cmd`] : [trimmed];
  for (const dir of pathValue.split(delimiter)) {
    const base = dir.trim().replace(/^["']|["']$/g, "");
    if (!base) {
      continue;
    }
    for (const name of names) {
      const candidate = NodePath.join(base, name);
      try {
        if (NodeFS.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export function resolveHermesPythonCandidate(
  hermesPath: string,
  platform: NodeJS.Platform,
): string | undefined {
  let resolved = hermesPath;
  try {
    resolved = NodeFS.realpathSync(hermesPath);
  } catch {
    resolved = hermesPath;
  }
  const dir = NodePath.dirname(resolved);
  const names = platform === "win32" ? ["python.exe"] : ["python", "python3"];
  for (const name of names) {
    const candidate = NodePath.join(dir, name);
    try {
      if (NodeFS.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

const discoverHermesInventoryModels = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const hermesCommand = hermesSettings.binaryPath || "hermes";
    const hermesPath = findHermesBinaryOnPath(hermesCommand, environment, platform);
    if (!hermesPath) {
      yield* Effect.logWarning("Hermes inventory skipped: hermes binary not found on PATH", {
        hermesCommand,
      });
      return [] as ReadonlyArray<ServerProviderModel>;
    }

    const pythonPath = resolveHermesPythonCandidate(hermesPath, platform);
    if (!pythonPath) {
      yield* Effect.logWarning("Hermes inventory skipped: venv python not found next to hermes", {
        hermesPath,
      });
      return [] as ReadonlyArray<ServerProviderModel>;
    }
    const spawnCommand = yield* resolveSpawnCommand(pythonPath, ["-c", HERMES_INVENTORY_SCRIPT], {
      env: environment,
    });
    const result = yield* spawnAndCollect(
      pythonPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    ).pipe(Effect.timeoutOption(HERMES_INVENTORY_DISCOVERY_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(result)) {
      yield* Effect.logWarning("Hermes inventory spawn failed", {
        pythonPath,
        errorTag: result.failure._tag,
      });
      return [] as ReadonlyArray<ServerProviderModel>;
    }
    if (Option.isNone(result.success)) {
      yield* Effect.logWarning("Hermes inventory timed out", {
        pythonPath,
        timeoutMs: HERMES_INVENTORY_DISCOVERY_TIMEOUT_MS,
      });
      return [] as ReadonlyArray<ServerProviderModel>;
    }
    if (result.success.value.code !== 0) {
      yield* Effect.logWarning("Hermes inventory exited nonzero", {
        pythonPath,
        exitCode: result.success.value.code,
        stderrLength: result.success.value.stderr.length,
      });
      return [] as ReadonlyArray<ServerProviderModel>;
    }

    const payload = parseHermesInventoryPayload(result.success.value.stdout);
    const models = buildHermesDiscoveredModelsFromInventory(payload);
    yield* Effect.logInfo(`Hermes inventory models loaded (${models.length})`);
    return models;
  });

const runHermesVersionCommand = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
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

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getHermesFallbackModels(hermesSettings);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runHermesVersionCommand(hermesSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Hermes CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Hermes CLI (`hermes`) is not installed or not on PATH."
          : "Failed to execute Hermes CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but timed out while running `hermes --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Hermes CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverHermesViaAcp(hermesSettings, environment).pipe(
    Effect.timeoutOption(HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.result,
  );
  const inventoryModels = yield* discoverHermesInventoryModels(hermesSettings, environment).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Hermes inventory model discovery failed", {
        errorTag: causeErrorTag(error),
      }).pipe(Effect.as([] as ReadonlyArray<ServerProviderModel>)),
    ),
  );

  if (Result.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Hermes ACP model discovery failed", {
      errorTag: discoveryExit.failure._tag,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models:
        inventoryModels.length > 0
          ? providerModelsFromSettings(
              inventoryModels,
              hermesSettings.customModels,
              EMPTY_CAPABILITIES,
            )
          : fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: HERMES_ACP_DISCOVERY_FAILED_MESSAGE,
      },
    });
  }

  if (Option.isNone(discoveryExit.success)) {
    yield* Effect.logWarning(
      `Hermes ACP model discovery timed out after ${HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models:
        inventoryModels.length > 0
          ? providerModelsFromSettings(
              inventoryModels,
              hermesSettings.customModels,
              EMPTY_CAPABILITIES,
            )
          : fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `Hermes CLI is installed but ACP startup timed out after ${HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discovery = discoveryExit.success.value;
  const authStatus = resolveHermesAuthStatus({
    authMethods: readHermesAuthMethods(discovery.initializeResult),
    sessionStarted: discovery.sessionStarted,
  });
  const discoveredModels = mergeHermesDiscoveredModels(discovery.models, inventoryModels);
  const models =
    discoveredModels.length > 0
      ? providerModelsFromSettings(
          discoveredModels,
          hermesSettings.customModels,
          EMPTY_CAPABILITIES,
        )
      : fallbackModels;
  const discoveryWarning = !discovery.sessionStarted
    ? HERMES_ACP_DISCOVERY_FAILED_MESSAGE
    : discoveredModels.length === 0
      ? HERMES_ACP_DISCOVERY_EMPTY_MESSAGE
      : undefined;
  const unauthenticated = authStatus.auth.status === "unauthenticated";
  const message = unauthenticated ? authStatus.message : discoveryWarning;
  const status = unauthenticated ? "error" : discoveryWarning ? "warning" : "ready";

  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: hermesSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status,
      auth: authStatus.auth,
      ...(message ? { message } : {}),
    },
  });
});

export const enrichHermesSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Hermes version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
