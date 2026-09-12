// @effect-diagnostics globalDate:off -- observedAt is an ISO instant compared as epoch millis.
/**
 * Merges per-environment limit snapshots into the view the Limits page renders.
 *
 * @module usageLimitsMerge
 */
import {
  USAGE_LIMITS_CONTRACT_VERSION,
  USAGE_LIMITS_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageLimitProviderSnapshot,
  type UsageLimitsSummary,
  type UsageProviderKind,
  type UsageSourceFingerprint,
} from "@t3tools/contracts";

export interface EnvironmentUsageLimits {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageLimitsSummary;
}

export interface MergedUsageLimitProvider extends UsageLimitProviderSnapshot {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

export interface MergedUsageLimits {
  readonly providers: readonly MergedUsageLimitProvider[];
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  readonly staleEnvironments: readonly EnvironmentId[];
}

function fingerprintKey(fingerprint: UsageSourceFingerprint): string {
  return [
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ].join(" ");
}

function isCompatibleContractVersion(version: number, expected: number): boolean {
  return version >= USAGE_LIMITS_MERGE_COMPATIBLE_SINCE && version <= expected;
}

function observedMs(snapshot: UsageLimitProviderSnapshot): number {
  if (snapshot.observedAt === null) return 0;
  const parsed = Date.parse(snapshot.observedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function mergeUsageLimits(
  environments: readonly EnvironmentUsageLimits[],
  expectedVersion = USAGE_LIMITS_CONTRACT_VERSION,
): MergedUsageLimits {
  const staleEnvironments: EnvironmentId[] = [];
  const contributing: EnvironmentUsageLimits[] = [];
  for (const environment of environments) {
    if (!isCompatibleContractVersion(environment.summary.contractVersion, expectedVersion)) {
      staleEnvironments.push(environment.environmentId);
      continue;
    }
    contributing.push(environment);
  }

  const ordered = [...contributing].sort((a, b) => a.environmentId.localeCompare(b.environmentId));
  const ownerByFingerprint = new Map<string, MergedUsageLimitProvider>();
  const duplicateSources: string[] = [];

  for (const environment of ordered) {
    for (const snapshot of environment.summary.providers) {
      const key = fingerprintKey(snapshot.fingerprint);
      const existing = ownerByFingerprint.get(key);
      if (existing === undefined) {
        ownerByFingerprint.set(key, {
          ...snapshot,
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
        });
        continue;
      }
      duplicateSources.push(`${environment.label}: ${snapshot.fingerprint.resolvedHomePath}`);
      if (observedMs(snapshot) > observedMs(existing)) {
        ownerByFingerprint.set(key, {
          ...snapshot,
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
        });
      }
    }
  }

  const providerOrder: readonly UsageProviderKind[] = ["codex", "claude", "grok"];
  const providers = [...ownerByFingerprint.values()].sort((a, b) => {
    const environment = a.environmentLabel.localeCompare(b.environmentLabel);
    if (environment !== 0) return environment;
    return providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider);
  });

  const contributingEnvironments = [
    ...new Set(providers.map((provider) => provider.environmentId)),
  ];

  return {
    providers,
    duplicateSources,
    contributingEnvironments,
    staleEnvironments,
  };
}
