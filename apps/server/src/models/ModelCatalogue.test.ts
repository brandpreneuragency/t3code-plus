import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  CATALOGUE_CACHE_TTL_MS,
  CATALOGUE_SECRET_NAME,
  ModelCatalogueService,
  buildSummary,
  layer,
} from "./ModelCatalogue.ts";

const wireModel = {
  sourceModelId: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  vendorLabel: "Anthropic",
  contextTokens: 200000,
  inputPerMillion: 3,
  cachedReadPerMillion: 0.3,
  outputPerMillion: 15,
  visionSupport: "yes",
  reasoningSupport: "yes",
  parallelAgentSupport: "yes",
  bestUse: "long refactors",
  avoidFor: "cheap batch work",
  benchmarkConfidence: 82,
  favourite: true,
  status: "active",
  verifiedOn: "2026-08-23",
  aliases: [],
} as const;

const envelope = {
  catalogueVersion: 1,
  generatedAt: "2026-09-04T00:00:00Z",
  models: [wireModel],
} as const;

const provider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-04T00:00:00Z",
  models: [
    {
      slug: "claude-sonnet-5.0",
      name: "Claude Sonnet 5",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

describe("buildSummary", () => {
  it("marks a model the local providers expose", () => {
    const summary = buildSummary({
      envelope,
      providerModels: [
        { instanceId: ProviderInstanceId.make("claude"), slug: "claude-sonnet-5.0" },
      ],
      readAt: "2026-09-04T10:00:00Z",
      fetchedAt: "2026-09-04T10:00:01Z",
    });

    assert.strictEqual(summary.status, "ok");
    assert.lengthOf(summary.entries, 1);
    assert.deepStrictEqual(summary.entries[0]?.availability, [
      {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-sonnet-5.0",
        matchedBy: "normalized",
      },
    ]);
  });

  it("leaves availability empty for a catalogue-only model", () => {
    const summary = buildSummary({
      envelope,
      providerModels: [{ instanceId: ProviderInstanceId.make("codex"), slug: "gpt-5.6-luna" }],
      readAt: "2026-09-04T10:00:00Z",
      fetchedAt: "2026-09-04T10:00:01Z",
    });

    assert.deepStrictEqual(summary.entries[0]?.availability, []);
  });

  it("drops the per-model status field from the client contract", () => {
    const summary = buildSummary({
      envelope,
      providerModels: [],
      readAt: "2026-09-04T10:00:00Z",
      fetchedAt: "2026-09-04T10:00:01Z",
    });

    assert.isFalse(Object.hasOwn(summary.entries[0]!, "status"));
  });
});

const httpLayer = (
  handler: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      handler(request).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      ),
    ),
  );

const secretLayer = (credential: string | null, onSet?: (value: Uint8Array) => void) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    (() => {
      let current = credential;
      return ServerSecretStore.ServerSecretStore.of({
        get: (name: string) =>
          Effect.succeed(
            name === CATALOGUE_SECRET_NAME && current !== null
              ? Option.some(new TextEncoder().encode(current))
              : Option.none(),
          ),
        set: (name: string, value: Uint8Array) =>
          Effect.sync(() => {
            if (name === CATALOGUE_SECRET_NAME) {
              current = Buffer.from(value).toString("utf8");
              onSet?.(value);
            }
          }),
        create: () => Effect.die("create should not be called"),
        getOrCreateRandom: () => Effect.die("getOrCreateRandom should not be called"),
        remove: (name: string) =>
          Effect.sync(() => {
            if (name === CATALOGUE_SECRET_NAME) current = null;
          }),
      });
    })(),
  );

const providerLayer = (providers: ReadonlyArray<ServerProvider> = [provider]) =>
  Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed(providers),
  });

const serviceLayer = (input: {
  readonly url?: string;
  readonly credential?: string | null;
  readonly onSet?: (value: Uint8Array) => void;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly http: Parameters<typeof httpLayer>[0];
}) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ modelCatalogueUrl: input.url ?? "https://catalogue.test" }),
        secretLayer(
          input.credential === undefined ? "user:password" : input.credential,
          input.onSet,
        ),
        providerLayer(input.providers),
        httpLayer(input.http),
      ),
    ),
  );

const readWith = (input: Parameters<typeof serviceLayer>[0]) =>
  Effect.gen(function* () {
    const service = yield* ModelCatalogueService;
    return yield* service.read();
  }).pipe(Effect.provide(serviceLayer(input)));

describe("ModelCatalogueService", () => {
  it.effect("writes and clears credentials without exposing their value", () => {
    let stored: Uint8Array | undefined;
    return Effect.gen(function* () {
      const service = yield* ModelCatalogueService;
      assert.deepStrictEqual(yield* service.readCredentialStatus(), { configured: false });
      assert.deepStrictEqual(yield* service.setCredential({ username: "usér", password: "päss" }), {
        configured: true,
      });
      assert.deepStrictEqual(
        Array.from(stored ?? []),
        Array.from(new TextEncoder().encode("usér:päss")),
      );
      assert.deepStrictEqual(yield* service.clearCredential(), { configured: false });
      assert.deepStrictEqual(yield* service.readCredentialStatus(), { configured: false });
    }).pipe(
      Effect.provide(
        serviceLayer({
          credential: null,
          onSet: (value) => {
            stored = value;
          },
          http: () => Effect.die("HTTP should not be called"),
        }),
      ),
    );
  });

  it.effect("rejects unsafe credential input", () =>
    Effect.gen(function* () {
      const service = yield* ModelCatalogueService;
      const result = yield* Effect.result(
        service.setCredential({ username: "bad:name", password: "secret" }),
      );
      assert.strictEqual(result._tag, "Failure");
    }).pipe(
      Effect.provide(
        serviceLayer({
          credential: null,
          http: () => Effect.die("HTTP should not be called"),
        }),
      ),
    ),
  );

  it.effect("reports unconfigured when the URL is empty", () =>
    readWith({
      url: "",
      credential: null,
      http: () => Effect.die("HTTP should not be called"),
    }).pipe(
      Effect.tap((summary) =>
        Effect.sync(() => assert.strictEqual(summary.status, "unconfigured")),
      ),
    ),
  );

  it.effect("reports invalid when the configured URL cannot be parsed", () =>
    readWith({
      url: "not a URL",
      http: () => Effect.die("HTTP should not be called"),
    }).pipe(
      Effect.tap((summary) =>
        Effect.sync(() => {
          assert.strictEqual(summary.status, "invalid");
          assert.match(summary.message ?? "", /URL/i);
        }),
      ),
    ),
  );

  it.effect("rejects plaintext HTTP before attaching the credential", () =>
    readWith({
      url: "http://catalogue.test",
      http: () => Effect.die("HTTP should not be called"),
    }).pipe(
      Effect.tap((summary) =>
        Effect.sync(() => {
          assert.strictEqual(summary.status, "invalid");
          assert.strictEqual(summary.entries.length, 0);
        }),
      ),
    ),
  );

  it.effect("fetches and decodes a catalogue with a UTF-8-safe Basic auth header", () => {
    let authorization: string | undefined;
    return readWith({
      credential: "usér:päss",
      http: (request) => {
        authorization = request.headers.authorization;
        return Effect.succeed(Response.json(envelope));
      },
    }).pipe(
      Effect.tap((summary) =>
        Effect.sync(() => {
          assert.strictEqual(summary.status, "ok");
          assert.strictEqual(
            authorization,
            `Basic ${Buffer.from("usér:päss", "utf8").toString("base64")}`,
          );
          assert.deepStrictEqual(summary.entries[0]?.availability[0]?.model, "claude-sonnet-5.0");
        }),
      ),
    );
  });

  it.effect("reports invalid for malformed response bodies", () =>
    readWith({
      http: () =>
        Effect.succeed(new Response("{", { headers: { "content-type": "application/json" } })),
    }).pipe(
      Effect.tap((summary) =>
        Effect.sync(() => {
          assert.strictEqual(summary.status, "invalid");
          assert.strictEqual(summary.entries.length, 0);
        }),
      ),
    ),
  );

  it.effect("reports invalid for an unsupported wire version", () =>
    readWith({
      http: () => Effect.succeed(Response.json({ ...envelope, catalogueVersion: 2 })),
    }).pipe(
      Effect.tap((summary) => Effect.sync(() => assert.strictEqual(summary.status, "invalid"))),
    ),
  );

  it.effect("reports unreachable for an HTTP status failure", () =>
    readWith({ http: () => Effect.succeed(new Response("down", { status: 503 })) }).pipe(
      Effect.tap((summary) => Effect.sync(() => assert.strictEqual(summary.status, "unreachable"))),
    ),
  );

  it.effect("reports unreachable for a rejected connection", () =>
    readWith({
      http: (request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: "connection refused",
            }),
          }),
        ),
    }).pipe(
      Effect.tap((summary) => Effect.sync(() => assert.strictEqual(summary.status, "unreachable"))),
    ),
  );

  it.effect("serves a stale snapshot when a refresh becomes unreachable", () => {
    let requestCount = 0;
    return Effect.gen(function* () {
      const service = yield* ModelCatalogueService;
      const first = yield* service.read();
      yield* TestClock.adjust(`${CATALOGUE_CACHE_TTL_MS + 1} millis`);
      const second = yield* service.read();
      assert.strictEqual(first.status, "ok");
      assert.strictEqual(second.status, "unreachable");
      assert.lengthOf(second.entries, 1);
      assert.strictEqual(second.fetchedAt, first.fetchedAt);
      assert.notStrictEqual(second.fetchedAt, envelope.generatedAt);
      assert.strictEqual(requestCount, 2);
    }).pipe(
      Effect.provide(
        serviceLayer({
          http: (request) => {
            requestCount += 1;
            return requestCount === 1
              ? Effect.succeed(Response.json(envelope))
              : Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: "offline",
                    }),
                  }),
                );
          },
        }),
      ),
    );
  });
});
