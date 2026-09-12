/**
 * Remaining plan-limit snapshots.
 *
 * Historical token cost lives in {@link ./usage.ts}. This contract is the
 * latest 5-hour / weekly (or equivalent) window each provider wrote into its
 * local session files. It is last-seen, not a live account query.
 *
 * @module usageLimits
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageProviderKind, UsageSourceFingerprint } from "./usage.ts";

export const USAGE_LIMITS_CONTRACT_VERSION = 1 as const;
export const USAGE_LIMITS_MERGE_COMPATIBLE_SINCE = 1 as const;

export const UsageLimitProviderStatus = Schema.Literals(["ok", "missing", "unsupported"]);
export type UsageLimitProviderStatus = typeof UsageLimitProviderStatus.Type;

export const UsageLimitWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedPercent: Schema.NullOr(Schema.Number),
  windowMinutes: Schema.NullOr(NonNegativeInt),
  resetsAt: Schema.NullOr(Schema.Number),
  reached: Schema.Boolean,
});
export type UsageLimitWindow = typeof UsageLimitWindow.Type;

export const UsageLimitProviderSnapshot = Schema.Struct({
  provider: UsageProviderKind,
  status: UsageLimitProviderStatus,
  planType: Schema.NullOr(TrimmedNonEmptyString),
  observedAt: Schema.NullOr(Schema.String),
  windows: Schema.Array(UsageLimitWindow),
  message: Schema.NullOr(TrimmedNonEmptyString),
  fingerprint: UsageSourceFingerprint,
});
export type UsageLimitProviderSnapshot = typeof UsageLimitProviderSnapshot.Type;

export const UsageLimitsSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  providers: Schema.Array(UsageLimitProviderSnapshot),
  scanDurationMs: NonNegativeInt,
});
export type UsageLimitsSummary = typeof UsageLimitsSummary.Type;
