import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import {
  antigravityTerminalOutcome,
  antigravityToolItemType,
  makeAntigravityAdapter,
  mapRuntimeModeToAntigravity,
  parseAntigravityResume,
} from "./AntigravityAdapter.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function outputStream(lines: ReadonlyArray<Record<string, unknown>>) {
  return Stream.fromIterable(lines.map((line) => encoder.encode(`${JSON.stringify(line)}\n`)));
}

function makeCompletedHandle(input: {
  readonly lines: ReadonlyArray<Record<string, unknown>>;
  readonly stderr?: string;
  readonly stdinWrites: string[];
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(101),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => input.stdinWrites.push(decoder.decode(chunk, { stream: true }))),
    ),
    stdout: outputStream(input.lines),
    stderr: Stream.make(encoder.encode(input.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function assertFlagValue(args: ReadonlyArray<string>, flag: string, value: string) {
  const index = args.indexOf(flag);
  assert.isAtLeast(index, 0, `missing ${flag}`);
  assert.strictEqual(args[index + 1], value);
}

const adapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-antigravity-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it("decodes only the v1 explicit conversation cursor", () => {
  assert.isUndefined(parseAntigravityResume({ schemaVersion: 2, conversationId: "wrong" }));
  assert.isUndefined(parseAntigravityResume({ schemaVersion: 1, conversationId: "" }));
  assert.deepEqual(
    parseAntigravityResume({
      schemaVersion: 1,
      conversationId: " conversation-1 ",
      cumulativeUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    }),
    {
      schemaVersion: 1,
      conversationId: "conversation-1",
      cumulativeUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    },
  );
});

it("maps T3 runtime modes without permission escalation", () => {
  assert.strictEqual(mapRuntimeModeToAntigravity("approval-required"), "supervised");
  assert.strictEqual(mapRuntimeModeToAntigravity("auto"), "auto");
  assert.strictEqual(mapRuntimeModeToAntigravity("auto-accept-edits"), "auto-accept-edits");
  assert.strictEqual(mapRuntimeModeToAntigravity("full-access"), "full-access");
});

it("maps command, file-write, and other tools to canonical item types", () => {
  assert.strictEqual(antigravityToolItemType("run_command"), "command_execution");
  assert.strictEqual(antigravityToolItemType("write_to_file"), "file_change");
  assert.strictEqual(antigravityToolItemType("browser_search"), "dynamic_tool_call");
});

it("maps every terminal result status", () => {
  assert.deepEqual(antigravityTerminalOutcome({ kind: "result", status: "SUCCESS" }), {
    state: "completed",
  });
  for (const status of ["CANCELED", "INTERRUPTED"] as const) {
    assert.deepEqual(antigravityTerminalOutcome({ kind: "result", status }), {
      state: "interrupted",
    });
  }
  for (const status of ["ERROR", "INVALID", "WAITING", "RUNNING"] as const) {
    assert.strictEqual(antigravityTerminalOutcome({ kind: "result", status }).state, "failed");
  }
});

it.layer(adapterTestLayer)("AntigravityAdapter", (it) => {
  it.effect("streams once, deduplicates result.response, and returns the new cursor", () =>
    Effect.gen(function* () {
      const commands: ReadonlyArray<string>[] = [];
      const stdinWrites: string[] = [];
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          commands.push((command as unknown as { args: ReadonlyArray<string> }).args);
          return Effect.succeed(
            makeCompletedHandle({
              stdinWrites,
              lines: [
                {
                  event: "init",
                  conversation_id: "conversation-1",
                  init: { permission_mode: "request-review" },
                },
                {
                  event: "step_update",
                  step_update: {
                    conversation_id: "conversation-1",
                    step_index: 2,
                    state: "ACTIVE",
                    step_type: "agent_response",
                    text_delta: "hel",
                  },
                },
                {
                  event: "step_update",
                  step_update: {
                    conversation_id: "conversation-1",
                    step_index: 2,
                    state: "DONE",
                    step_type: "agent_response",
                    text_delta: "lo",
                  },
                },
                {
                  event: "result",
                  result: {
                    conversation_id: "conversation-1",
                    status: "SUCCESS",
                    response: "hello",
                    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
                  },
                },
              ],
            }),
          );
        }),
      );
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true })).pipe(
        Effect.provide(spawner),
      );
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const threadId = ThreadId.make("antigravity-stream-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        runtimeMode: "approval-required",
        modelSelection: {
          instanceId: ProviderInstanceId.make("antigravity"),
          model: "gemini-3.8-flash-medium",
        },
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventFiber);

      assert.deepEqual(turn.resumeCursor, {
        schemaVersion: 1,
        conversationId: "conversation-1",
      });
      const deltas = events
        .filter((event) => event.type === "content.delta")
        .map((event) => (event.type === "content.delta" ? event.payload.delta : ""));
      assert.deepEqual(deltas, ["hel", "lo"]);
      assert.lengthOf(
        events.filter((event) => event.type === "runtime.warning"),
        1,
      );
      assert.include(commands[0] ?? [], "--sandbox");
      assert.strictEqual(stdinWrites.join(""), '{"event":"user","message":{"content":"hello"}}\n');

      const session = (yield* adapter.listSessions())[0];
      assert.deepInclude(session?.resumeCursor as object, {
        conversationId: "conversation-1",
        cumulativeUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("kills only its captured child when interrupted", () =>
    Effect.gen(function* () {
      const killCalls = yield* Ref.make(0);
      const running = yield* Ref.make(true);
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(202),
              exitCode: Effect.never,
              isRunning: Ref.get(running),
              kill: () =>
                Ref.set(running, false).pipe(Effect.andThen(Ref.update(killCalls, (n) => n + 1))),
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.never,
              stderr: Stream.never,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        ),
      );
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true })).pipe(
        Effect.provide(spawner),
      );
      const threadId = ThreadId.make("antigravity-interrupt-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, conversationId: "conversation-existing" },
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "wait" });
      yield* adapter.interruptTurn(threadId, turn.turnId);
      assert.strictEqual(yield* Ref.get(killCalls), 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resumes the same conversation while changing the selected model", () =>
    Effect.gen(function* () {
      const commands: ReadonlyArray<string>[] = [];
      let spawnIndex = 0;
      const responses = [
        {
          event: "result",
          result: {
            conversation_id: "conversation-existing",
            status: "SUCCESS",
            response: "one",
            usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
          },
        },
        {
          event: "result",
          result: {
            conversation_id: "conversation-existing",
            status: "SUCCESS",
            response: "two",
            usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
          },
        },
      ];
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          commands.push((command as unknown as { args: ReadonlyArray<string> }).args);
          const response = responses[spawnIndex++];
          return Effect.succeed(
            makeCompletedHandle({
              stdinWrites: [],
              lines: response ? [response] : [],
            }),
          );
        }),
      );
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true })).pipe(
        Effect.provide(spawner),
      );
      assert.strictEqual(adapter.capabilities.sessionModelSwitch, "in-session");
      const completedCount = yield* Ref.make(0);
      const firstCompleted = yield* Deferred.make<void>();
      const secondCompleted = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed"
          ? Ref.updateAndGet(completedCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.succeed(firstCompleted, undefined)
                  : count === 2
                    ? Deferred.succeed(secondCompleted, undefined)
                    : Effect.void,
              ),
            )
          : Effect.void,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const threadId = ThreadId.make("antigravity-model-switch-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          conversationId: "conversation-existing",
          cumulativeUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "one",
        modelSelection: {
          instanceId: ProviderInstanceId.make("antigravity"),
          model: "gemini-3.8-flash-medium",
        },
      });
      yield* Deferred.await(firstCompleted);
      yield* adapter.sendTurn({
        threadId,
        input: "two",
        modelSelection: {
          instanceId: ProviderInstanceId.make("antigravity"),
          model: "gemini-3.8-flash-high",
        },
      });
      yield* Deferred.await(secondCompleted);
      yield* Fiber.interrupt(eventFiber);

      assert.lengthOf(commands, 2);
      assertFlagValue(commands[0] ?? [], "--conversation", "conversation-existing");
      assertFlagValue(commands[0] ?? [], "--model", "gemini-3.8-flash-medium");
      assertFlagValue(commands[1] ?? [], "--conversation", "conversation-existing");
      assertFlagValue(commands[1] ?? [], "--model", "gemini-3.8-flash-high");
      const session = (yield* adapter.listSessions())[0];
      assert.deepInclude(session?.resumeCursor as object, {
        conversationId: "conversation-existing",
        cumulativeUsage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails a turn whose process exits without a terminal result", () =>
    Effect.gen(function* () {
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeCompletedHandle({
              stdinWrites: [],
              lines: [{ event: "init", conversation_id: "conversation-no-result" }],
            }),
          ),
        ),
      );
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true })).pipe(
        Effect.provide(spawner),
      );
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const threadId = ThreadId.make("antigravity-no-result-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventFiber);

      assert.lengthOf(
        events.filter((event) => event.type === "runtime.error"),
        1,
      );
      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.strictEqual(
        turnCompleted?.type === "turn.completed" ? turnCompleted.payload.state : undefined,
        "failed",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("passes a resolved attachment parent once for multiple files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const commands: ReadonlyArray<string>[] = [];
      const attachments = [
        {
          type: "file" as const,
          id: "antigravity-attachment-one",
          name: "one.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
        {
          type: "file" as const,
          id: "antigravity-attachment-two",
          name: "two.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
      ];
      yield* Effect.forEach(attachments, (attachment) =>
        fileSystem.writeFile(
          `${serverConfig.attachmentsDir}/${attachment.id}.txt`,
          encoder.encode("x"),
        ),
      );
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          commands.push((command as unknown as { args: ReadonlyArray<string> }).args);
          return Effect.succeed(
            makeCompletedHandle({
              stdinWrites: [],
              lines: [
                {
                  event: "result",
                  result: { conversation_id: "conversation-attachments", status: "SUCCESS" },
                },
              ],
            }),
          );
        }),
      );
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true })).pipe(
        Effect.provide(spawner),
      );
      const completed = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const threadId = ThreadId.make("antigravity-attachments-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, conversationId: "conversation-attachments" },
      });
      yield* adapter.sendTurn({ threadId, input: "read them", attachments });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventFiber);

      const args = commands[0] ?? [];
      assert.lengthOf(
        args.filter((value) => value === "--add-dir"),
        1,
      );
      assertFlagValue(args, "--add-dir", serverConfig.attachmentsDir);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an unresolved attachment without spawning a process", () =>
    Effect.gen(function* () {
      const spawnCalls = yield* Ref.make(0);
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Ref.update(spawnCalls, (count) => count + 1).pipe(
            Effect.andThen(Effect.succeed(makeCompletedHandle({ stdinWrites: [], lines: [] }))),
          ),
        ),
      );
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true })).pipe(
        Effect.provide(spawner),
      );
      const threadId = ThreadId.make("antigravity-missing-attachment-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        runtimeMode: "full-access",
      });
      const failure = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "missing",
          attachments: [
            {
              type: "file",
              id: "antigravity-missing-attachment",
              name: "missing.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
            },
          ],
        }),
      );
      assert.strictEqual(failure._tag, "ProviderAdapterProcessError");
      assert.strictEqual(yield* Ref.get(spawnCalls), 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
