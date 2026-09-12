/**
 * Opt-in smoke test against an installed and authenticated official `agy` CLI.
 *
 * Run with:
 *   T3_ANTIGRAVITY_LIVE=1 T3_ANTIGRAVITY_BINARY=/path/to/agy vp test run AntigravityAdapter.live
 *
 * The suite consumes provider quota and is skipped in ordinary local and CI runs.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderTurnStartResult,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import {
  type AntigravityAdapterShape,
  makeAntigravityAdapter,
  parseAntigravityResume,
} from "./AntigravityAdapter.ts";
import { checkAntigravityProviderStatus } from "./AntigravityProvider.ts";

const INSTANCE_ID = ProviderInstanceId.make("antigravity");
const MEDIUM_MODEL = "gemini-3.8-flash-medium";
const HIGH_MODEL = "gemini-3.8-flash-high";
const decodeSettings = Schema.decodeSync(AntigravitySettings);

const liveLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-antigravity-live-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function startEventCollector(adapter: AntigravityAdapterShape) {
  return Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const completions =
      yield* Queue.unbounded<Extract<ProviderRuntimeEvent, { readonly type: "turn.completed" }>>();
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => events.push(event)).pipe(
        Effect.andThen(
          event.type === "turn.completed" ? Queue.offer(completions, event) : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    return { events, completions, fiber };
  });
}

const awaitCompletion = (
  completions: Queue.Queue<Extract<ProviderRuntimeEvent, { readonly type: "turn.completed" }>>,
  turnId: TurnId,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(completions);
      if (event.turnId === turnId) return event;
    }
  });

function streamedText(events: ReadonlyArray<ProviderRuntimeEvent>, turn: ProviderTurnStartResult) {
  return events
    .filter((event) => event.type === "content.delta" && event.turnId === turn.turnId)
    .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
    .join("");
}

describe.runIf(process.env.T3_ANTIGRAVITY_LIVE === "1")("Antigravity live smoke", () => {
  it.live("discovers, streams, resumes, switches models, restarts, and interrupts", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        enabled: true,
        binaryPath: process.env.T3_ANTIGRAVITY_BINARY ?? "agy",
      });
      const snapshot = yield* checkAntigravityProviderStatus(settings);
      assert.strictEqual(snapshot.status, "ready");
      assert.strictEqual(snapshot.auth.status, "authenticated");
      assert.include(
        snapshot.models.map((model) => model.slug),
        MEDIUM_MODEL,
      );
      assert.include(
        snapshot.models.map((model) => model.slug),
        HIGH_MODEL,
      );

      const firstAdapter = yield* makeAntigravityAdapter(settings);
      const firstCollector = yield* startEventCollector(firstAdapter);
      const threadId = ThreadId.make("antigravity-live-thread");
      yield* firstAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        runtimeMode: "auto-accept-edits",
      });

      const firstTurn = yield* firstAdapter.sendTurn({
        threadId,
        input: "Reply with exactly AGY_T3_ONE and no other text. Do not use tools.",
        modelSelection: { instanceId: INSTANCE_ID, model: MEDIUM_MODEL },
      });
      const firstCompleted = yield* awaitCompletion(firstCollector.completions, firstTurn.turnId);
      assert.strictEqual(firstCompleted.payload.state, "completed");
      assert.include(streamedText(firstCollector.events, firstTurn), "AGY_T3_ONE");
      const firstCursor = parseAntigravityResume(firstTurn.resumeCursor);
      assert.isDefined(firstCursor);

      const secondTurn = yield* firstAdapter.sendTurn({
        threadId,
        input:
          "Reply with exactly AGY_T3_TWO if the previous marker was AGY_T3_ONE. Do not use tools.",
        modelSelection: { instanceId: INSTANCE_ID, model: HIGH_MODEL },
      });
      const secondCompleted = yield* awaitCompletion(firstCollector.completions, secondTurn.turnId);
      assert.strictEqual(secondCompleted.payload.state, "completed");
      assert.include(streamedText(firstCollector.events, secondTurn), "AGY_T3_TWO");

      const persistedCursor = parseAntigravityResume(
        (yield* firstAdapter.listSessions())[0]?.resumeCursor,
      );
      assert.isDefined(persistedCursor);
      assert.strictEqual(persistedCursor?.conversationId, firstCursor?.conversationId);
      yield* firstAdapter.stopAll();
      yield* Fiber.interrupt(firstCollector.fiber);

      // Reconstructing the adapter and session from the persisted cursor models
      // the provider-side portion of a T3 server restart.
      const restartedAdapter = yield* makeAntigravityAdapter(settings);
      const restartedCollector = yield* startEventCollector(restartedAdapter);
      yield* restartedAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        runtimeMode: "auto-accept-edits",
        resumeCursor: persistedCursor,
      });
      const restartedTurn = yield* restartedAdapter.sendTurn({
        threadId,
        input:
          "Reply with exactly AGY_T3_RESTART if this conversation remembers AGY_T3_TWO. Do not use tools.",
        modelSelection: { instanceId: INSTANCE_ID, model: MEDIUM_MODEL },
      });
      const restartedCompleted = yield* awaitCompletion(
        restartedCollector.completions,
        restartedTurn.turnId,
      );
      assert.strictEqual(restartedCompleted.payload.state, "completed");
      assert.include(streamedText(restartedCollector.events, restartedTurn), "AGY_T3_RESTART");
      assert.strictEqual(
        parseAntigravityResume(restartedTurn.resumeCursor)?.conversationId,
        persistedCursor?.conversationId,
      );

      const interruptedTurn = yield* restartedAdapter.sendTurn({
        threadId,
        input: "Write a detailed 2000-word explanation of distributed consensus. Do not use tools.",
        modelSelection: { instanceId: INSTANCE_ID, model: MEDIUM_MODEL },
      });
      yield* restartedAdapter.interruptTurn(threadId, interruptedTurn.turnId);
      const interruptedCompleted = yield* awaitCompletion(
        restartedCollector.completions,
        interruptedTurn.turnId,
      );
      assert.strictEqual(interruptedCompleted.payload.state, "interrupted");

      yield* restartedAdapter.stopAll();
      yield* Fiber.interrupt(restartedCollector.fiber);
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );
});
