import {
  type AntigravitySettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ProviderTurnStartResult,
  RuntimeItemId,
  type RuntimeMode,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ANTIGRAVITY_DEFAULT_BINARY,
  type AntigravityRuntimeMode,
  antigravityPrintTurnArgs,
  antigravityUserMessage,
} from "../antigravityLaunchArgs.ts";
import { antigravityErrorMessage } from "../antigravityCliParse.ts";
import {
  type AntigravityCumulativeUsage,
  type AntigravityParsedEvent,
  antigravityUsageSnapshot,
  parseAntigravityCumulativeUsage,
  parseAntigravityNdjsonLine,
} from "../antigravityEvents.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { collectStreamAsString } from "../providerSnapshot.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const RESUME_VERSION = 1 as const;
const MAX_STDERR_BYTES = 16_384;
const MAX_DIAGNOSTICS = 20;

export type AntigravityAdapterShape = ProviderAdapterShape<
  | ProviderAdapterProcessError
  | ProviderAdapterRequestError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError
>;

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

export interface AntigravityResumeCursorV1 {
  readonly schemaVersion: 1;
  readonly conversationId: string;
  readonly cumulativeUsage?: AntigravityCumulativeUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAntigravityResume(raw: unknown): AntigravityResumeCursorV1 | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== RESUME_VERSION) return undefined;
  if (typeof raw.conversationId !== "string" || !raw.conversationId.trim()) return undefined;

  const cumulativeUsage = parseAntigravityCumulativeUsage(
    isRecord(raw.cumulativeUsage)
      ? {
          input_tokens: raw.cumulativeUsage.inputTokens,
          output_tokens: raw.cumulativeUsage.outputTokens,
          thinking_tokens: raw.cumulativeUsage.thinkingTokens,
          cache_read_tokens: raw.cumulativeUsage.cacheReadTokens,
          total_tokens: raw.cumulativeUsage.totalTokens,
        }
      : undefined,
  );
  return {
    schemaVersion: RESUME_VERSION,
    conversationId: raw.conversationId.trim(),
    ...(cumulativeUsage ? { cumulativeUsage } : {}),
  };
}

export function mapRuntimeModeToAntigravity(runtimeMode: RuntimeMode): AntigravityRuntimeMode {
  switch (runtimeMode) {
    case "full-access":
      return "full-access";
    case "auto-accept-edits":
      return "auto-accept-edits";
    case "auto":
      return "auto";
    case "approval-required":
      return "supervised";
  }
}

export function antigravityToolItemType(
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" {
  const normalized = toolName.toLowerCase();
  if (/command|shell|terminal|bash/.test(normalized)) return "command_execution";
  if (/file|write|edit|patch/.test(normalized)) return "file_change";
  return "dynamic_tool_call";
}

export interface AntigravityTerminalOutcome {
  readonly state: "completed" | "failed" | "interrupted";
  readonly message?: string;
}

export function antigravityTerminalOutcome(
  status: Extract<AntigravityParsedEvent, { readonly kind: "result" }>,
): AntigravityTerminalOutcome {
  if (status.status === "SUCCESS") return { state: "completed" };
  if (status.status === "CANCELED" || status.status === "INTERRUPTED") {
    return { state: "interrupted", ...(status.error ? { message: status.error } : {}) };
  }
  return {
    state: "failed",
    message:
      status.error ??
      (status.status === "RUNNING"
        ? "Antigravity ended without a terminal result status."
        : `Antigravity ended with ${status.status}.`),
  };
}

interface AntigravitySessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  session: ProviderSession;
  conversationId: string | undefined;
  cumulativeUsage: AntigravityCumulativeUsage | undefined;
  lastUsage: ThreadTokenUsageSnapshot | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  activeFiber: Fiber.Fiber<void, unknown> | undefined;
  killActive: (() => Effect.Effect<void, never>) | undefined;
  assistantItemId: string | undefined;
  assistantCompleted: boolean;
  streamedResponse: boolean;
  terminalOutcome: AntigravityTerminalOutcome | undefined;
  terminalResultSeen: boolean;
  diagnostics: string[];
  toolItemsStarted: Set<string>;
  interruptedTurnIds: Set<TurnId>;
  settledTurnIds: Set<TurnId>;
  stopped: boolean;
}

function samePath(left: string, right: string, platform: NodeJS.Platform) {
  return platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
}

export const makeAntigravityAdapter = Effect.fn("makeAntigravityAdapter")(function* (
  settings: AntigravitySettings,
  options: AntigravityAdapterLiveOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const serverConfig = yield* ServerConfig;
  const environment = options.environment ?? process.env;
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("antigravity");
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, AntigravitySessionContext>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create an Antigravity runtime event ID.",
          cause,
        }),
    ),
  );
  const makeEventStamp = () =>
    Effect.all({ eventId: Effect.map(randomUUIDv4, EventId.make), createdAt: nowIso });
  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId) =>
    Effect.sync(() => sessions.get(threadId)).pipe(
      Effect.flatMap((context) =>
        context && !context.stopped
          ? Effect.succeed(context)
          : new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
      ),
    );

  const makeResumeCursor = (
    context: AntigravitySessionContext,
  ): AntigravityResumeCursorV1 | undefined =>
    context.conversationId
      ? {
          schemaVersion: RESUME_VERSION,
          conversationId: context.conversationId,
          ...(context.cumulativeUsage ? { cumulativeUsage: context.cumulativeUsage } : {}),
        }
      : undefined;

  const publishSessionCursor = (
    context: AntigravitySessionContext,
    turnId: TurnId,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      const resumeCursor = makeResumeCursor(context);
      if (!resumeCursor) return;
      context.session = { ...context.session, resumeCursor, updatedAt: yield* nowIso };
      yield* offerRuntimeEvent({
        type: "session.configured",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        turnId,
        payload: { config: { resumeCursor } },
      });
    });

  const emitRuntimeError = (context: AntigravitySessionContext, turnId: TurnId, message: string) =>
    makeEventStamp().pipe(
      Effect.flatMap((stamp) =>
        offerRuntimeEvent({
          type: "runtime.error",
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          payload: { message, class: "provider_error" },
        }),
      ),
    );

  const ensureAssistantItem = (
    context: AntigravitySessionContext,
    turnId: TurnId,
  ): Effect.Effect<string, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      if (context.assistantItemId) return context.assistantItemId;
      const itemId = yield* randomUUIDv4;
      context.assistantItemId = itemId;
      yield* offerRuntimeEvent({
        type: "item.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        turnId,
        itemId: RuntimeItemId.make(itemId),
        payload: { itemType: "assistant_message", status: "inProgress" },
      });
      return itemId;
    });

  const completeAssistantItem = (
    context: AntigravitySessionContext,
    turnId: TurnId,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      if (!context.assistantItemId || context.assistantCompleted) return;
      context.assistantCompleted = true;
      yield* offerRuntimeEvent({
        type: "item.completed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        turnId,
        itemId: RuntimeItemId.make(context.assistantItemId),
        payload: { itemType: "assistant_message", status: "completed" },
      });
    });

  const emitAssistantDelta = (
    context: AntigravitySessionContext,
    turnId: TurnId,
    text: string,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      const itemId = yield* ensureAssistantItem(context, turnId);
      context.streamedResponse = true;
      yield* offerRuntimeEvent({
        type: "content.delta",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        turnId,
        itemId: RuntimeItemId.make(itemId),
        payload: { streamKind: "assistant_text", delta: text },
      });
    });

  const recordDiagnostic = (context: AntigravitySessionContext, message: string) =>
    Effect.sync(() => {
      if (context.diagnostics.length === MAX_DIAGNOSTICS) context.diagnostics.shift();
      context.diagnostics.push(message);
    });

  const updateConversation = (
    context: AntigravitySessionContext,
    turnId: TurnId,
    conversationId: string | undefined,
    cursorReady: Deferred.Deferred<AntigravityResumeCursorV1 | undefined>,
  ) =>
    Effect.gen(function* () {
      if (conversationId) context.conversationId = conversationId;
      yield* publishSessionCursor(context, turnId);
      yield* Deferred.succeed(cursorReady, makeResumeCursor(context));
    });

  const handleParsedEvent = (
    context: AntigravitySessionContext,
    turnId: TurnId,
    parsed: AntigravityParsedEvent,
    cursorReady: Deferred.Deferred<AntigravityResumeCursorV1 | undefined>,
    resultSeen: Deferred.Deferred<void>,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      if (context.interruptedTurnIds.has(turnId)) return;

      if (parsed.kind === "diagnostic") {
        yield* recordDiagnostic(context, parsed.message);
        return;
      }

      if (parsed.kind === "init") {
        yield* updateConversation(context, turnId, parsed.conversationId, cursorReady);
        return;
      }

      if (parsed.kind === "text") {
        if (parsed.conversationId && !context.conversationId) {
          yield* updateConversation(context, turnId, parsed.conversationId, cursorReady);
        }
        yield* emitAssistantDelta(context, turnId, parsed.text);
        if (parsed.state === "DONE") yield* completeAssistantItem(context, turnId);
        return;
      }

      if (parsed.kind === "tool") {
        if (parsed.conversationId && !context.conversationId) {
          yield* updateConversation(context, turnId, parsed.conversationId, cursorReady);
        }
        const itemId = `${context.conversationId ?? context.threadId}:${parsed.stepIndex}`;
        const alreadyStarted = context.toolItemsStarted.has(itemId);
        const type =
          parsed.state === "DONE"
            ? "item.completed"
            : alreadyStarted
              ? "item.updated"
              : "item.started";
        context.toolItemsStarted.add(itemId);
        yield* offerRuntimeEvent({
          type,
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: {
            itemType: antigravityToolItemType(parsed.toolName),
            status: parsed.state === "DONE" ? "completed" : "inProgress",
            title: parsed.toolName,
            ...(parsed.detail ? { detail: parsed.detail } : {}),
          },
        });
        return;
      }

      context.terminalResultSeen = parsed.status !== "RUNNING";
      if (parsed.conversationId) context.conversationId = parsed.conversationId;
      if (parsed.response && !context.streamedResponse) {
        yield* emitAssistantDelta(context, turnId, parsed.response);
        yield* completeAssistantItem(context, turnId);
      }

      const previousUsage = context.cumulativeUsage;
      const usage = antigravityUsageSnapshot(parsed.usage, previousUsage);
      if (parsed.usage) context.cumulativeUsage = parsed.usage;
      if (usage) {
        context.lastUsage = usage;
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          payload: { usage },
        });
      }
      yield* publishSessionCursor(context, turnId);
      yield* Deferred.succeed(cursorReady, makeResumeCursor(context));

      context.terminalOutcome = antigravityTerminalOutcome(parsed);
      context.turns = [...context.turns, { id: turnId, items: [parsed] }];
      yield* Deferred.succeed(resultSeen, undefined);
    });

  const settleTurn = (
    context: AntigravitySessionContext,
    turnId: TurnId,
    outcome: AntigravityTerminalOutcome,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      if (context.settledTurnIds.has(turnId)) return;
      context.settledTurnIds.add(turnId);
      yield* completeAssistantItem(context, turnId);

      context.activeTurnId = undefined;
      context.activeFiber = undefined;
      context.killActive = undefined;
      context.assistantItemId = undefined;
      context.session = {
        ...context.session,
        status: context.stopped ? "closed" : "ready",
        updatedAt: yield* nowIso,
        ...(makeResumeCursor(context) ? { resumeCursor: makeResumeCursor(context) } : {}),
      };
      yield* offerRuntimeEvent({
        type: "turn.completed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        turnId,
        payload: {
          state: outcome.state,
          stopReason:
            outcome.state === "completed"
              ? "end_turn"
              : outcome.state === "interrupted"
                ? "cancelled"
                : "error",
          ...(context.lastUsage ? { usage: context.lastUsage } : {}),
          ...(outcome.message ? { errorMessage: outcome.message } : {}),
        },
      });
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        payload: { state: context.stopped ? "stopped" : "ready" },
      });
    });

  const resolveAttachmentDirectories = (input: ProviderSendTurnInput) =>
    Effect.gen(function* () {
      const directories = new Set<string>();
      const profileRoots = [environment.USERPROFILE, environment.HOME]
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => path.normalize(path.resolve(entry)));

      for (const attachment of input.attachments ?? []) {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }

        const info = yield* fileSystem.stat(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/start",
                detail: `Failed to resolve attachment '${attachment.name}'.`,
                cause,
              }),
          ),
        );
        if (info.type !== "File") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Attachment '${attachment.name}' is not a file.`,
          });
        }

        const directory = path.normalize(path.resolve(path.dirname(attachmentPath)));
        const unsafe =
          !path.isAbsolute(directory) ||
          path.dirname(directory) === directory ||
          /[*?[\]{}]/.test(directory) ||
          profileRoots.some((profileRoot) => samePath(directory, profileRoot, platform));
        if (unsafe) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Refusing unsafe Antigravity attachment directory for '${attachment.name}'.`,
          });
        }
        directories.add(directory);
      }

      return [...directories];
    });

  const runTurn = (
    context: AntigravitySessionContext,
    turnId: TurnId,
    input: ProviderSendTurnInput,
    processStarted: Deferred.Deferred<boolean>,
    cursorReady: Deferred.Deferred<AntigravityResumeCursorV1 | undefined>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const attachmentDirectories = yield* resolveAttachmentDirectories(input);
        const model =
          input.modelSelection?.instanceId === boundInstanceId
            ? input.modelSelection.model
            : context.session.model;
        const runtimeMode = mapRuntimeModeToAntigravity(context.session.runtimeMode);
        const args = antigravityPrintTurnArgs({
          runtimeMode,
          plan: input.interactionMode === "plan",
          attachmentDirectories,
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          ...(model ? { model } : {}),
        });
        const binary = settings.binaryPath || ANTIGRAVITY_DEFAULT_BINARY;
        const spawnCommand = yield* resolveSpawnCommand(binary, [...args], {
          env: environment,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: context.threadId,
                detail: "Failed to resolve the Antigravity CLI executable.",
                cause,
              }),
          ),
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              env: environment,
              cwd: context.session.cwd,
              shell: spawnCommand.shell,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: context.threadId,
                  detail: "Failed to start the Antigravity CLI.",
                  cause,
                }),
            ),
          );

        // Every termination path targets this exact captured handle. No process
        // lookup by executable name, cwd, or worktree is used.
        const killChild = child.isRunning.pipe(
          Effect.flatMap((isRunning) => (isRunning ? child.kill() : Effect.void)),
          Effect.ignore,
        );
        context.killActive = () => killChild;
        yield* Effect.addFinalizer(() => killChild);
        yield* Deferred.succeed(processStarted, true);

        const resultSeen = yield* Deferred.make<void>();
        const stdoutDone = yield* Deferred.make<void>();
        const releaseStdin = yield* Deferred.make<void>();
        const stdout = child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            handleParsedEvent(
              context,
              turnId,
              parseAntigravityNdjsonLine(line),
              cursorReady,
              resultSeen,
            ),
          ),
          Effect.ensuring(Deferred.succeed(stdoutDone, undefined).pipe(Effect.ignore)),
        );
        const waitToCloseStdin = Effect.raceAllFirst([
          Deferred.await(resultSeen),
          Deferred.await(stdoutDone),
          child.exitCode.pipe(Effect.asVoid),
        ]).pipe(
          Effect.flatMap(() => Deferred.succeed(releaseStdin, undefined)),
          Effect.asVoid,
        );
        const stdin = Stream.make(antigravityUserMessage(input.input ?? "")).pipe(
          Stream.concat(Stream.fromEffect(Deferred.await(releaseStdin)).pipe(Stream.map(() => ""))),
          Stream.encodeText,
          Stream.run(child.stdin),
        );

        const [stderr, , , , exitCode] = yield* Effect.all(
          [
            collectStreamAsString(child.stderr, { maxBytes: MAX_STDERR_BYTES }),
            stdout,
            stdin,
            waitToCloseStdin,
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (context.interruptedTurnIds.has(turnId) || context.stopped) return;

        const parsedOutcome = context.terminalOutcome;
        let finalOutcome: AntigravityTerminalOutcome;
        if (!context.terminalResultSeen || !parsedOutcome) {
          finalOutcome = {
            state: "failed",
            message: "Antigravity ended without a terminal result event.",
          };
        } else if (parsedOutcome.state === "completed" && !context.conversationId) {
          finalOutcome = {
            state: "failed",
            message: "Antigravity completed without a conversation ID.",
          };
        } else if (Number(exitCode) !== 0 && parsedOutcome.state === "completed") {
          finalOutcome = {
            state: "failed",
            message:
              antigravityErrorMessage(stderr) ??
              `Antigravity exited with code ${Number(exitCode)}.`,
          };
        } else if (parsedOutcome.state === "failed") {
          const message =
            antigravityErrorMessage(`${parsedOutcome.message ?? ""}\n${stderr}`) ??
            parsedOutcome.message;
          finalOutcome = {
            ...parsedOutcome,
            ...(message ? { message } : {}),
          };
        } else {
          finalOutcome = parsedOutcome;
        }

        if (finalOutcome.state === "failed" && finalOutcome.message) {
          yield* emitRuntimeError(context, turnId, finalOutcome.message);
        }
        yield* settleTurn(context, turnId, finalOutcome);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (context.interruptedTurnIds.has(turnId) || context.stopped) return;
          const message = cause.toString() || "Antigravity turn failed.";
          yield* emitRuntimeError(context, turnId, message);
          yield* settleTurn(context, turnId, { state: "failed", message });
        }),
      ),
      Effect.ensuring(
        Effect.all(
          [
            Deferred.succeed(processStarted, false),
            Deferred.succeed(cursorReady, makeResumeCursor(context)),
          ],
          { discard: true },
        ).pipe(Effect.ignore),
      ),
      Effect.asVoid,
    );

  const startSession: AntigravityAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) return existing.session;

      const resumed = parseAntigravityResume(input.resumeCursor);
      const now = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd ?? serverConfig.cwd,
        ...(input.modelSelection?.instanceId === boundInstanceId && input.modelSelection.model
          ? { model: input.modelSelection.model }
          : {}),
        threadId: input.threadId,
        ...(resumed ? { resumeCursor: resumed } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const scope = yield* Scope.make("sequential");
      sessions.set(input.threadId, {
        threadId: input.threadId,
        scope,
        session,
        conversationId: resumed?.conversationId,
        cumulativeUsage: resumed?.cumulativeUsage,
        lastUsage: undefined,
        turns: [],
        activeTurnId: undefined,
        activeFiber: undefined,
        killActive: undefined,
        assistantItemId: undefined,
        assistantCompleted: false,
        streamedResponse: false,
        terminalOutcome: undefined,
        terminalResultSeen: false,
        diagnostics: [],
        toolItemsStarted: new Set(),
        interruptedTurnIds: new Set(),
        settledTurnIds: new Set(),
        stopped: false,
      });
      return session;
    });

  const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (context.activeTurnId) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: "An Antigravity turn is already running on this thread.",
        });
      }

      const turnId = TurnId.make(yield* randomUUIDv4);
      const processStarted = yield* Deferred.make<boolean>();
      const cursorReady = yield* Deferred.make<AntigravityResumeCursorV1 | undefined>();
      const selectedModel =
        input.modelSelection?.instanceId === boundInstanceId
          ? input.modelSelection.model
          : undefined;
      context.activeTurnId = turnId;
      context.assistantItemId = undefined;
      context.assistantCompleted = false;
      context.streamedResponse = false;
      context.terminalOutcome = undefined;
      context.terminalResultSeen = false;
      context.lastUsage = undefined;
      context.diagnostics = [];
      context.toolItemsStarted.clear();
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
        ...(selectedModel ? { model: selectedModel } : {}),
      };

      yield* offerRuntimeEvent({
        type: "turn.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        turnId,
        payload: context.session.model ? { model: context.session.model } : {},
      });
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        turnId,
        payload: { state: "running" },
      });
      if (context.session.runtimeMode !== "full-access") {
        yield* offerRuntimeEvent({
          type: "runtime.warning",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          payload: {
            message:
              "Antigravity headless mode cannot pause for inline approval; approval-required operations may be soft-denied.",
          },
        });
      }

      context.activeFiber = yield* runTurn(
        context,
        turnId,
        input,
        processStarted,
        cursorReady,
      ).pipe(Effect.forkIn(context.scope));
      const started = yield* Deferred.await(processStarted);
      if (!started) {
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.threadId,
          detail: "Antigravity failed before its turn process started.",
        });
      }

      const resumeCursor = makeResumeCursor(context) ?? (yield* Deferred.await(cursorReady));
      return {
        threadId: input.threadId,
        turnId,
        ...(resumeCursor ? { resumeCursor } : {}),
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context || context.stopped) return;
      const activeTurnId = context.activeTurnId;
      if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) return;
      const interruptedTurnId = turnId ?? activeTurnId;
      if (!interruptedTurnId) return;

      context.interruptedTurnIds.add(interruptedTurnId);
      const activeFiber = context.activeFiber;
      if (context.killActive) yield* context.killActive();
      if (activeFiber) yield* Fiber.interrupt(activeFiber).pipe(Effect.ignore);
      yield* settleTurn(context, interruptedTurnId, { state: "interrupted" });
    });

  const unsupported = (method: string) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail:
          "Antigravity headless mode does not support interactive approvals or user-input requests.",
      }),
    );

  const stopSessionInternal = (context: AntigravitySessionContext) =>
    Effect.gen(function* () {
      const activeTurnId = context.activeTurnId;
      context.stopped = true;
      if (activeTurnId) {
        context.interruptedTurnIds.add(activeTurnId);
        const activeFiber = context.activeFiber;
        if (context.killActive) yield* context.killActive();
        if (activeFiber) yield* Fiber.interrupt(activeFiber).pipe(Effect.ignore);
        yield* settleTurn(context, activeTurnId, { state: "interrupted" });
      }
      yield* Effect.ignore(Scope.close(context.scope, Exit.void));
      context.session = { ...context.session, status: "closed", updatedAt: yield* nowIso };
      sessions.delete(context.threadId);
    });

  const stopSession: AntigravityAdapterShape["stopSession"] = (threadId) =>
    Effect.flatMap(requireSession(threadId), stopSessionInternal);
  const stopAll: AntigravityAdapterShape["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopSessionInternal, { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.ignore(stopAll()).pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({
        threadId,
        turns: context.turns,
      })),
    rollbackThread: (threadId, numTurns) =>
      Number.isInteger(numTurns) && numTurns > 0
        ? Effect.andThen(requireSession(threadId), unsupported("thread/rollback"))
        : Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            }),
          ),
    respondToRequest: (_threadId, _requestId, _decision: ProviderApprovalDecision) =>
      unsupported("session/request_permission"),
    respondToUserInput: (_threadId, _requestId, _answers: ProviderUserInputAnswers) =>
      unsupported("user-input/respond"),
    stopSession,
    listSessions: () =>
      Effect.sync(() => [...sessions.values()].map((context) => ({ ...context.session }))),
    hasSession: (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      }),
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  } satisfies AntigravityAdapterShape;
});
