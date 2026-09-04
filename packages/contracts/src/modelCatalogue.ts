/**
 * The llm-monitor catalogue as T3 serves it to clients.
 *
 * Two schemas live here: `CatalogueWireEnvelope` is what the remote returns
 * and is untrusted; `ModelCatalogueSummary` is what T3 hands its own clients,
 * with availability already resolved server-side.
 *
 * @module modelCatalogue
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MODEL_CATALOGUE_CONTRACT_VERSION = 1 as const;
export const MODEL_CATALOGUE_WIRE_VERSION = 1 as const;

const CappedText = (max: number) => Schema.NullOr(Schema.String.check(Schema.isMaxLength(max)));

/** The remote payload. Every field is hostile until decoded. */
export const CatalogueWireModel = Schema.Struct({
  sourceModelId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  name: Schema.String.check(Schema.isMaxLength(200)),
  vendorLabel: CappedText(100),
  contextTokens: Schema.NullOr(NonNegativeInt),
  inputPerMillion: Schema.NullOr(Schema.Number),
  cachedReadPerMillion: Schema.NullOr(Schema.Number),
  outputPerMillion: Schema.NullOr(Schema.Number),
  // These are short descriptions, not booleans. The live catalogue includes
  // qualifiers such as supported media and endpoint caveats, so 32 characters
  // rejects valid rows. Keep them bounded while leaving room for that detail.
  visionSupport: CappedText(256),
  reasoningSupport: CappedText(256),
  parallelAgentSupport: CappedText(256),
  bestUse: CappedText(1000),
  avoidFor: CappedText(1000),
  benchmarkConfidence: Schema.NullOr(Schema.Number),
  favourite: Schema.Boolean,
  status: CappedText(32),
  verifiedOn: CappedText(32),
  aliases: Schema.Array(Schema.String.check(Schema.isMaxLength(200))),
});
export type CatalogueWireModel = typeof CatalogueWireModel.Type;

export const CatalogueWireEnvelope = Schema.Struct({
  catalogueVersion: Schema.Number,
  generatedAt: Schema.String,
  models: Schema.Array(CatalogueWireModel),
});
export type CatalogueWireEnvelope = typeof CatalogueWireEnvelope.Type;

export const ModelCatalogueStatus = Schema.Literals([
  "ok",
  "unconfigured",
  "unreachable",
  "invalid",
]);
export type ModelCatalogueStatus = typeof ModelCatalogueStatus.Type;

export const ModelCatalogueMatchTier = Schema.Literals(["exact", "normalized", "alias"]);
export type ModelCatalogueMatchTier = typeof ModelCatalogueMatchTier.Type;

export const ModelCatalogueAvailability = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** T3's spelling of the model, not the catalogue's. */
  model: TrimmedNonEmptyString,
  matchedBy: ModelCatalogueMatchTier,
});
export type ModelCatalogueAvailability = typeof ModelCatalogueAvailability.Type;

export const ModelCatalogueEntry = Schema.Struct({
  sourceModelId: TrimmedNonEmptyString,
  name: Schema.String,
  vendorLabel: Schema.NullOr(Schema.String),
  contextTokens: Schema.NullOr(NonNegativeInt),
  inputPerMillion: Schema.NullOr(Schema.Number),
  cachedReadPerMillion: Schema.NullOr(Schema.Number),
  outputPerMillion: Schema.NullOr(Schema.Number),
  visionSupport: Schema.NullOr(Schema.String),
  reasoningSupport: Schema.NullOr(Schema.String),
  parallelAgentSupport: Schema.NullOr(Schema.String),
  bestUse: Schema.NullOr(Schema.String),
  avoidFor: Schema.NullOr(Schema.String),
  benchmarkConfidence: Schema.NullOr(Schema.Number),
  favourite: Schema.Boolean,
  verifiedOn: Schema.NullOr(Schema.String),
  /** Empty means the catalogue knows this model but no local provider offers it. */
  availability: Schema.Array(ModelCatalogueAvailability),
});
export type ModelCatalogueEntry = typeof ModelCatalogueEntry.Type;

export const ModelCatalogueSummary = Schema.Struct({
  contractVersion: Schema.Number,
  status: ModelCatalogueStatus,
  /** When the server answered this request. */
  readAt: Schema.String,
  /** When the served snapshot was actually fetched. Null when never fetched. */
  fetchedAt: Schema.NullOr(Schema.String),
  entries: Schema.Array(ModelCatalogueEntry),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ModelCatalogueSummary = typeof ModelCatalogueSummary.Type;

/** Deliberately write-only credential status exposed to clients. */
export const ModelCatalogueCredentialStatus = Schema.Struct({
  configured: Schema.Boolean,
});
export type ModelCatalogueCredentialStatus = typeof ModelCatalogueCredentialStatus.Type;

/** Credentials are accepted only for the write RPC and are never returned. */
export const ModelCatalogueCredentialInput = Schema.Struct({
  username: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[^:]+$/),
  ),
  password: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
});
export type ModelCatalogueCredentialInput = typeof ModelCatalogueCredentialInput.Type;

export const ModelCatalogueCredentialUpdate = Schema.Union([
  Schema.Struct({ clear: Schema.Literal(true) }),
  Schema.Struct({ clear: Schema.Literal(false), credentials: ModelCatalogueCredentialInput }),
]);
export type ModelCatalogueCredentialUpdate = typeof ModelCatalogueCredentialUpdate.Type;

export const ModelCatalogueCredentialOperation = Schema.Literals(["read", "write", "remove"]);

export class ModelCatalogueCredentialError extends Schema.TaggedErrorClass<ModelCatalogueCredentialError>()(
  "ModelCatalogueCredentialError",
  { operation: ModelCatalogueCredentialOperation },
) {
  override get message(): string {
    return `Model catalogue credential ${this.operation} failed.`;
  }
}
