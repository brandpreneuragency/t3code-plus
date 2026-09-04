/**
 * Serves the llm-monitor catalogue with availability resolved against the
 * locally installed providers.
 *
 * Fetch failure is never an RPC error: the summary carries a `status` and,
 * where possible, the last good snapshot. A page that says "as of 14:02" is
 * more useful than one that says "error".
 *
 * @module ModelCatalogue
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  MODEL_CATALOGUE_CONTRACT_VERSION,
  MODEL_CATALOGUE_WIRE_VERSION,
  CatalogueWireEnvelope,
  ModelCatalogueCredentialError,
  type ModelCatalogueCredentialInput,
  type ModelCatalogueCredentialStatus,
  type ProviderInstanceId,
  type ModelCatalogueEntry,
  type ModelCatalogueSummary,
} from "@t3tools/contracts";
import { matchCatalogueEntry, type ProviderModelRef } from "@t3tools/shared/modelId";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

export const CATALOGUE_CACHE_TTL_MS = 15 * 60 * 1000;
export const CATALOGUE_FETCH_TIMEOUT_MS = 5000;
export const CATALOGUE_SECRET_NAME = "modelCatalogue.basicAuth";

export function buildSummary(input: {
  readonly envelope: CatalogueWireEnvelope;
  readonly providerModels: ReadonlyArray<ProviderModelRef<ProviderInstanceId>>;
  readonly readAt: string;
  readonly fetchedAt: string;
}): ModelCatalogueSummary {
  const entries: ReadonlyArray<ModelCatalogueEntry> = input.envelope.models.map((model) => ({
    sourceModelId: model.sourceModelId,
    name: model.name,
    vendorLabel: model.vendorLabel,
    contextTokens: model.contextTokens,
    inputPerMillion: model.inputPerMillion,
    cachedReadPerMillion: model.cachedReadPerMillion,
    outputPerMillion: model.outputPerMillion,
    visionSupport: model.visionSupport,
    reasoningSupport: model.reasoningSupport,
    parallelAgentSupport: model.parallelAgentSupport,
    bestUse: model.bestUse,
    avoidFor: model.avoidFor,
    benchmarkConfidence: model.benchmarkConfidence,
    favourite: model.favourite,
    verifiedOn: model.verifiedOn,
    availability: matchCatalogueEntry({
      sourceModelId: model.sourceModelId,
      aliases: model.aliases,
      providerModels: input.providerModels,
    }),
  }));

  return {
    contractVersion: MODEL_CATALOGUE_CONTRACT_VERSION,
    status: "ok",
    readAt: input.readAt,
    fetchedAt: input.fetchedAt,
    entries,
    message: null,
  };
}

/** Flattens the registry snapshot into the shape the matcher consumes. */
export function toProviderModelRefs<InstanceId extends string>(
  providers: ReadonlyArray<{
    readonly instanceId: InstanceId;
    readonly models: ReadonlyArray<{ readonly slug: string }>;
  }>,
): ReadonlyArray<ProviderModelRef<InstanceId>> {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({ instanceId: provider.instanceId, slug: model.slug })),
  );
}

export class ModelCatalogueService extends Context.Service<
  ModelCatalogueService,
  {
    readonly read: () => Effect.Effect<ModelCatalogueSummary>;
    readonly readCredentialStatus: () => Effect.Effect<
      ModelCatalogueCredentialStatus,
      ModelCatalogueCredentialError
    >;
    readonly setCredential: (
      input: ModelCatalogueCredentialInput,
    ) => Effect.Effect<ModelCatalogueCredentialStatus, ModelCatalogueCredentialError>;
    readonly clearCredential: () => Effect.Effect<
      ModelCatalogueCredentialStatus,
      ModelCatalogueCredentialError
    >;
  }
>()("t3/models/ModelCatalogue/ModelCatalogueService") {}

/** Disabled catalogue, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  ModelCatalogueService,
  ModelCatalogueService.of({
    read: () =>
      Effect.succeed({
        contractVersion: MODEL_CATALOGUE_CONTRACT_VERSION,
        status: "unconfigured" as const,
        readAt: "1970-01-01T00:00:00.000Z",
        fetchedAt: null,
        entries: [],
        message: null,
      }),
    readCredentialStatus: () => Effect.succeed({ configured: false }),
    setCredential: () => Effect.succeed({ configured: true }),
    clearCredential: () => Effect.succeed({ configured: false }),
  }),
);

type CachedSnapshot = {
  readonly envelope: CatalogueWireEnvelope;
  readonly fetchedAtMs: number;
  readonly fetchedAt: string;
  readonly endpoint: string;
};

const emptySummary = (input: {
  readonly status: "unconfigured" | "unreachable" | "invalid";
  readonly readAt: string;
  readonly message: string | null;
}): ModelCatalogueSummary => ({
  contractVersion: MODEL_CATALOGUE_CONTRACT_VERSION,
  status: input.status,
  readAt: input.readAt,
  fetchedAt: null,
  entries: [],
  message: input.message,
});

const isInvalidFetchFailure = (failure: unknown): boolean =>
  Schema.isSchemaError(failure) ||
  (HttpClientError.isHttpClientError(failure) &&
    (failure.reason._tag === "DecodeError" || failure.reason._tag === "EmptyBodyError"));

const resolveCatalogueEndpoint = (baseUrl: string): string | null => {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
      return null;
    }
    return new URL("/api/models", parsed).toString();
  } catch {
    return null;
  }
};

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const cache = yield* Ref.make<CachedSnapshot | null>(null);

  const readCredentialStatus = () =>
    secrets.get(CATALOGUE_SECRET_NAME).pipe(
      Effect.map((value) => ({ configured: Option.isSome(value) })),
      Effect.mapError(() => new ModelCatalogueCredentialError({ operation: "read" })),
    );

  const setCredential = (input: ModelCatalogueCredentialInput) => {
    const invalid =
      input.username.length === 0 ||
      input.username.length > 256 ||
      input.username.includes(":") ||
      input.password.length === 0 ||
      input.password.length > 4096;
    if (invalid) {
      return Effect.fail(new ModelCatalogueCredentialError({ operation: "write" }));
    }
    const value = new TextEncoder().encode(`${input.username}:${input.password}`);
    return secrets.set(CATALOGUE_SECRET_NAME, value).pipe(
      Effect.tap(() => Ref.set(cache, null)),
      Effect.as({ configured: true }),
      Effect.mapError(() => new ModelCatalogueCredentialError({ operation: "write" })),
    );
  };

  const clearCredential = () =>
    secrets.remove(CATALOGUE_SECRET_NAME).pipe(
      Effect.tap(() => Ref.set(cache, null)),
      Effect.as({ configured: false }),
      Effect.mapError(() => new ModelCatalogueCredentialError({ operation: "remove" })),
    );

  const fetchEnvelope = (endpoint: string, credential: string) =>
    HttpClientRequest.get(endpoint).pipe(
      HttpClientRequest.setHeader("authorization", `Basic ${credential}`),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(CatalogueWireEnvelope)),
      Effect.timeout(CATALOGUE_FETCH_TIMEOUT_MS),
    );

  /**
   * Serving a stale snapshot beats serving an error: the page says "as of
   * 14:02" and stays useful while the remote is down.
   */
  const serveCached = (endpoint: string, readAt: string, message: string) =>
    Effect.gen(function* () {
      const cached = yield* Ref.get(cache);
      const providerModels = toProviderModelRefs(yield* providerRegistry.getProviders);
      if (cached === null || cached.endpoint !== endpoint) {
        return emptySummary({ status: "unreachable", readAt, message });
      }
      return {
        ...buildSummary({
          envelope: cached.envelope,
          providerModels,
          readAt,
          fetchedAt: cached.fetchedAt,
        }),
        status: "unreachable" as const,
        message,
      };
    });

  const read = () =>
    Effect.gen(function* () {
      const readAt = DateTime.formatIso(yield* DateTime.now);

      const settings = yield* settingsService.getSettings.pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (settings === null) {
        return emptySummary({
          status: "invalid",
          readAt,
          message: "Server settings could not be read.",
        });
      }

      const baseUrl = settings.modelCatalogueUrl;
      if (baseUrl === "") {
        return emptySummary({ status: "unconfigured", readAt, message: null });
      }
      const endpoint = resolveCatalogueEndpoint(baseUrl);
      if (endpoint === null) {
        return emptySummary({
          status: "invalid",
          readAt,
          message: "The configured model catalogue URL is invalid.",
        });
      }

      const secretResult = yield* Effect.result(secrets.get(CATALOGUE_SECRET_NAME));
      if (Result.isFailure(secretResult)) {
        return emptySummary({
          status: "invalid",
          readAt,
          message: "The model catalogue credential could not be read.",
        });
      }
      const secret = secretResult.success;
      if (Option.isNone(secret)) {
        return emptySummary({
          status: "unconfigured",
          readAt,
          message: "No catalogue credential is configured.",
        });
      }
      const credential = Buffer.from(secret.value).toString("base64");

      const cached = yield* Ref.get(cache);
      const providerModels = toProviderModelRefs(yield* providerRegistry.getProviders);
      const nowMs = yield* Clock.currentTimeMillis;
      if (
        cached !== null &&
        cached.endpoint === endpoint &&
        nowMs - cached.fetchedAtMs < CATALOGUE_CACHE_TTL_MS
      ) {
        return buildSummary({
          envelope: cached.envelope,
          providerModels,
          readAt,
          fetchedAt: cached.fetchedAt,
        });
      }

      const result = yield* Effect.result(fetchEnvelope(endpoint, credential));
      if (Result.isFailure(result)) {
        return isInvalidFetchFailure(result.failure)
          ? emptySummary({
              status: "invalid",
              readAt,
              message: "The model catalogue returned a payload this build cannot read.",
            })
          : yield* serveCached(endpoint, readAt, "The model catalogue could not be reached.");
      }

      const envelope = result.success;
      if (envelope.catalogueVersion !== MODEL_CATALOGUE_WIRE_VERSION) {
        return emptySummary({
          status: "invalid",
          readAt,
          message: `Catalogue version ${envelope.catalogueVersion} is not supported (expected ${MODEL_CATALOGUE_WIRE_VERSION}).`,
        });
      }

      const fetchedAtMs = yield* Clock.currentTimeMillis;
      const fetchedAt = DateTime.formatIso(yield* DateTime.now);
      yield* Ref.set(cache, {
        envelope,
        fetchedAtMs,
        fetchedAt,
        endpoint,
      });
      return buildSummary({ envelope, providerModels, readAt, fetchedAt });
    });

  return { read, readCredentialStatus, setCredential, clearCredential } as const;
});

export const layer = Layer.effect(ModelCatalogueService, make);
