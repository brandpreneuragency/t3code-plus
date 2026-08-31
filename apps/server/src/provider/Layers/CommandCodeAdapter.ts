import {
  type CommandCodeSettings,
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
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { ServerConfig } from "../../config.ts";
import { commandCodePrintTurnArgs } from "../commandCodeLaunchArgs.ts";
import { messageForCommandCodeExitCode } from "../commandCodeCliParse.ts";
import { commandCodeUsageSnapshot, parseCommandCodeNdjsonLine } from "../commandCodeEvents.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("commandCode");
const COMMAND_CODE_RESUME_VERSION = 1 as const;

export type CommandCodeAdapterShape = ProviderAdapterShape<
  | ProviderAdapterProcessError
  | ProviderAdapterRequestError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError
>;

export interface CommandCodeAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCommandCodeResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== COMMAND_CODE_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function toolItemType(toolName: string): "command_execution" | "file_change" | "dynamic_tool_call" {
  const name = toolName.toLowerCase();
  if (name.includes("shell") || name.includes("bash") || name.includes("command")) {
    return "command_execution";
  }
  if (name.includes("edit") || name.includes("write") || name.includes("file")) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

interface CommandCodeSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  session: ProviderSession;
  commandCodeSessionId: string | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  activeFiber: Fiber.Fiber<void, unknown> | undefined;
  killActive: (() => Effect.Effect<void, never>) | undefined;
  lastUsage: ThreadTokenUsageSnapshot | undefined;
  interruptedTurnIds: Set<TurnId>;
  assistantItemId: string | undefined;
  stopped: boolean;
}

export const makeCommandCodeAdapter = Effect.fn("makeCommandCodeAdapter")(function* (
  commandCodeSettings: CommandCodeSettings,
  options: CommandCodeAdapterLiveOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const environment = options.environment ?? process.env;
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("commandCode");
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CommandCodeSessionContext>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Command Code runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId) =>
    Effect.sync(() => sessions.get(threadId)).pipe(
      Effect.flatMap((ctx) =>
        ctx && !ctx.stopped
          ? Effect.succeed(ctx)
          : new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            }),
      ),
    );

  const startSession: CommandCodeAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        return existing.session;
      }
      const now = yield* nowIso;
      const scope = yield* Scope.make("sequential");
      const resumed = parseCommandCodeResume(input.resumeCursor);
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd ?? serverConfig.cwd,
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        ...(resumed
          ? {
              resumeCursor: {
                schemaVersion: COMMAND_CODE_RESUME_VERSION,
                sessionId: resumed.sessionId,
              },
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(input.threadId, {
        threadId: input.threadId,
        scope,
        session,
        commandCodeSessionId: resumed?.sessionId,
        turns: [],
        activeTurnId: undefined,
        activeFiber: undefined,
        killActive: undefined,
        lastUsage: undefined,
        interruptedTurnIds: new Set(),
        assistantItemId: undefined,
        stopped: false,
      });
      return session;
    });

  const emitParsedLine = (
    ctx: CommandCodeSessionContext,
    turnId: TurnId,
    line: string,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      const parsed = parseCommandCodeNdjsonLine(line);
      if (!parsed || ctx.interruptedTurnIds.has(turnId)) return;
      const stamp = yield* makeEventStamp();
      if (parsed.kind === "text") {
        if (!ctx.assistantItemId) {
          ctx.assistantItemId = yield* randomUUIDv4;
          yield* offerRuntimeEvent({
            type: "item.started",
            ...stamp,
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId,
            itemId: RuntimeItemId.make(ctx.assistantItemId),
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
        }
        yield* offerRuntimeEvent({
          type: "content.delta",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(ctx.assistantItemId),
          payload: { streamKind: "assistant_text", delta: parsed.text },
        });
        return;
      }
      if (parsed.kind === "thinking") {
        yield* offerRuntimeEvent({
          type: "content.delta",
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          payload: { streamKind: "reasoning_text", delta: parsed.text },
        });
        return;
      }
      if (parsed.kind === "tool") {
        yield* offerRuntimeEvent({
          type: parsed.status === "running" ? "item.updated" : "item.completed",
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(parsed.toolCallId),
          payload: {
            itemType: toolItemType(parsed.toolName),
            status: parsed.status === "running" ? "inProgress" : parsed.status,
            title: parsed.toolName,
            ...(parsed.detail ? { detail: parsed.detail } : {}),
          },
        });
        return;
      }
      if (parsed.sessionId) {
        ctx.commandCodeSessionId = parsed.sessionId;
        ctx.session = {
          ...ctx.session,
          resumeCursor: {
            schemaVersion: COMMAND_CODE_RESUME_VERSION,
            sessionId: parsed.sessionId,
          },
        };
      }
      if (parsed.finalText && !ctx.assistantItemId) {
        ctx.assistantItemId = yield* randomUUIDv4;
        yield* offerRuntimeEvent({
          type: "item.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(ctx.assistantItemId),
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
        yield* offerRuntimeEvent({
          type: "content.delta",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(ctx.assistantItemId),
          payload: { streamKind: "assistant_text", delta: parsed.finalText },
        });
      }
      const usage = commandCodeUsageSnapshot(parsed.usage);
      if (usage) {
        ctx.lastUsage = usage;
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          payload: { usage },
        });
      }
      ctx.turns = [...ctx.turns, { id: turnId, items: [parsed] }];
    });

  const settleTurn = (
    ctx: CommandCodeSessionContext,
    turnId: TurnId,
    input: {
      readonly state: "completed" | "failed" | "interrupted";
      readonly stopReason?: string;
      readonly errorMessage?: string;
      readonly usage?: ThreadTokenUsageSnapshot;
    },
  ) =>
    Effect.gen(function* () {
      if (ctx.assistantItemId) {
        yield* offerRuntimeEvent({
          type: "item.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(ctx.assistantItemId),
          payload: { itemType: "assistant_message", status: "completed" },
        });
      }
      const updatedAt = yield* nowIso;
      ctx.activeTurnId = undefined;
      ctx.activeFiber = undefined;
      ctx.killActive = undefined;
      ctx.assistantItemId = undefined;
      const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
      ctx.session = {
        ...readySession,
        status: ctx.stopped ? "closed" : "ready",
        updatedAt,
      };
      yield* offerRuntimeEvent({
        type: "turn.completed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: ctx.threadId,
        turnId,
        payload: {
          state: input.state,
          ...(input.stopReason ? { stopReason: input.stopReason } : {}),
          ...(input.usage ? { usage: input.usage } : {}),
          ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        },
      });
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: ctx.threadId,
        payload: { state: ctx.stopped ? "stopped" : "ready" },
      });
    });

  const runTurn = (ctx: CommandCodeSessionContext, turnId: TurnId, input: ProviderSendTurnInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const query = input.input?.trim() ?? "";
        const model =
          input.modelSelection?.instanceId === boundInstanceId
            ? input.modelSelection.model
            : ctx.session.model;
        const args = commandCodePrintTurnArgs({
          query,
          sessionId: ctx.commandCodeSessionId,
          model,
          plan: input.interactionMode === "plan",
        });
        const binary = commandCodeSettings.binaryPath || "command-code";
        const spawnCommand = yield* resolveSpawnCommand(binary, [...args], {
          env: environment,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: ctx.threadId,
                detail: `Failed to resolve Command Code binary: ${String(cause)}`,
                cause,
              }),
          ),
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              env: environment,
              cwd: ctx.session.cwd,
              shell: spawnCommand.shell,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  detail: `Failed to start Command Code: ${String(cause)}`,
                  cause,
                }),
            ),
          );
        ctx.killActive = () => child.kill().pipe(Effect.ignore);
        const [, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) => emitParsedLine(ctx, turnId, line)),
            ),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (ctx.interruptedTurnIds.has(turnId) || ctx.stopped) {
          return;
        }
        const code = Number(exitCode);
        if (code === 0) {
          yield* settleTurn(ctx, turnId, {
            state: "completed",
            stopReason: "end_turn",
            ...(ctx.lastUsage ? { usage: ctx.lastUsage } : {}),
          });
          return;
        }
        const errorMessage =
          messageForCommandCodeExitCode(code) ?? `Command Code exited with code ${code}.`;
        yield* offerRuntimeEvent({
          type: "runtime.error",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          payload: {
            message: errorMessage,
            class: code === 3 ? "permission_error" : "provider_error",
          },
        });
        yield* settleTurn(ctx, turnId, {
          state: code === 130 ? "interrupted" : "failed",
          stopReason: code === 130 ? "cancelled" : "error",
          errorMessage,
        });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (ctx.interruptedTurnIds.has(turnId) || ctx.stopped) return;
          yield* settleTurn(ctx, turnId, {
            state: "failed",
            stopReason: "error",
            errorMessage: cause.toString() || "Command Code turn failed.",
          });
        }),
      ),
      Effect.asVoid,
    );

  const sendTurn: CommandCodeAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(input.threadId);
      if (ctx.activeTurnId) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: "A Command Code turn is already running on this thread.",
        });
      }
      const turnId = TurnId.make(yield* randomUUIDv4);
      ctx.activeTurnId = turnId;
      ctx.assistantItemId = undefined;
      ctx.lastUsage = undefined;
      ctx.session = {
        ...ctx.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
      };
      yield* offerRuntimeEvent({
        type: "turn.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: ctx.threadId,
        turnId,
        payload: {
          ...(ctx.session.model ? { model: ctx.session.model } : {}),
        },
      });
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: ctx.threadId,
        turnId,
        payload: { state: "running" },
      });
      ctx.activeFiber = yield* runTurn(ctx, turnId, input).pipe(Effect.forkIn(ctx.scope));
      const result: ProviderTurnStartResult = {
        threadId: input.threadId,
        turnId,
        ...(ctx.session.resumeCursor ? { resumeCursor: ctx.session.resumeCursor } : {}),
      };
      return result;
    });

  const interruptTurn: CommandCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) return;
      const activeTurnId = ctx.activeTurnId;
      if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
        return;
      }
      const interruptedTurnId = turnId ?? activeTurnId;
      if (interruptedTurnId) {
        ctx.interruptedTurnIds.add(interruptedTurnId);
      }
      if (ctx.killActive) {
        yield* ctx.killActive();
      }
      if (interruptedTurnId) {
        yield* settleTurn(ctx, interruptedTurnId, {
          state: "interrupted",
          stopReason: "cancelled",
        });
      }
    });

  const respondToRequest: CommandCodeAdapterShape["respondToRequest"] = (
    _threadId,
    requestId,
    _decision: ProviderApprovalDecision,
  ) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/request_permission",
        detail: `Command Code runs in yolo/plan mode and has no pending approval ${requestId}.`,
      }),
    );

  const respondToUserInput: CommandCodeAdapterShape["respondToUserInput"] = (
    _threadId,
    requestId,
    _answers: ProviderUserInputAnswers,
  ) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "user-input/respond",
        detail: `Command Code headless runs do not collect user input (${requestId}).`,
      }),
    );

  const readThread: CommandCodeAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      return { threadId, turns: ctx.turns };
    });

  const rollbackThread: CommandCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "Command Code sessions do not support provider-side rollback yet.",
      });
    });

  const stopSessionInternal = (ctx: CommandCodeSessionContext) =>
    Effect.gen(function* () {
      ctx.stopped = true;
      if (ctx.killActive) {
        yield* ctx.killActive();
      }
      yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
      if (ctx.activeTurnId) {
        ctx.interruptedTurnIds.add(ctx.activeTurnId);
        yield* settleTurn(ctx, ctx.activeTurnId, {
          state: "interrupted",
          stopReason: "cancelled",
        });
      }
      ctx.session = {
        ...ctx.session,
        status: "closed",
        updatedAt: yield* nowIso,
      };
      sessions.delete(ctx.threadId);
    });

  const stopSession: CommandCodeAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      yield* stopSessionInternal(ctx);
    });

  const listSessions: CommandCodeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

  const hasSession: CommandCodeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const ctx = sessions.get(threadId);
      return ctx !== undefined && !ctx.stopped;
    });

  const stopAll: CommandCodeAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.ignore(stopAll()).pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  } satisfies CommandCodeAdapterShape;
});
