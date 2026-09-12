import { describe, expect, it } from "vite-plus/test";
import {
  USAGE_LIMITS_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageLimitProviderSnapshot,
  type UsageLimitsSummary,
  type UsageSourceFingerprint,
} from "@t3tools/contracts";

import { mergeUsageLimits } from "./usageLimitsMerge.ts";

function fingerprint(
  provider: UsageSourceFingerprint["provider"],
  path: string,
): UsageSourceFingerprint {
  return {
    hostId: "host",
    provider,
    resolvedHomePath: path,
    volumeId: "1:1",
  };
}

function snapshot(
  overrides: Partial<UsageLimitProviderSnapshot> &
    Pick<UsageLimitProviderSnapshot, "provider" | "fingerprint">,
): UsageLimitProviderSnapshot {
  return {
    status: "ok",
    planType: "plus",
    observedAt: "2026-09-02T12:00:00.000Z",
    windows: [
      {
        id: "primary",
        label: "5-hour",
        usedPercent: 7,
        windowMinutes: 300,
        resetsAt: 1788380391,
        reached: false,
      },
    ],
    message: null,
    ...overrides,
  };
}

function summary(providers: readonly UsageLimitProviderSnapshot[]): UsageLimitsSummary {
  return {
    contractVersion: USAGE_LIMITS_CONTRACT_VERSION,
    readAt: "2026-09-02T12:00:00.000Z",
    providers,
    scanDurationMs: 1,
  };
}

describe("mergeUsageLimits", () => {
  it("keeps one snapshot when two environments share a transcript directory", () => {
    const shared = fingerprint("codex", "/home/user/.codex/sessions");
    const merged = mergeUsageLimits([
      {
        environmentId: "b" as EnvironmentId,
        label: "Worktree",
        summary: summary([snapshot({ provider: "codex", fingerprint: shared })]),
      },
      {
        environmentId: "a" as EnvironmentId,
        label: "Main",
        summary: summary([snapshot({ provider: "codex", fingerprint: shared })]),
      },
    ]);

    expect(merged.providers).toHaveLength(1);
    expect(merged.providers[0]?.environmentLabel).toBe("Main");
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("prefers the newer snapshot for a shared directory", () => {
    const shared = fingerprint("codex", "/home/user/.codex/sessions");
    const merged = mergeUsageLimits([
      {
        environmentId: "a" as EnvironmentId,
        label: "Main",
        summary: summary([
          snapshot({
            provider: "codex",
            fingerprint: shared,
            observedAt: "2026-09-02T11:00:00.000Z",
          }),
        ]),
      },
      {
        environmentId: "b" as EnvironmentId,
        label: "Worktree",
        summary: summary([
          snapshot({
            provider: "codex",
            fingerprint: shared,
            observedAt: "2026-09-02T12:00:00.000Z",
          }),
        ]),
      },
    ]);

    expect(merged.providers[0]?.environmentLabel).toBe("Worktree");
    expect(merged.providers[0]?.observedAt).toBe("2026-09-02T12:00:00.000Z");
  });

  it("drops summaries from an incompatible contract version", () => {
    const merged = mergeUsageLimits([
      {
        environmentId: "a" as EnvironmentId,
        label: "Old",
        summary: {
          ...summary([]),
          contractVersion: 0,
        },
      },
    ]);

    expect(merged.providers).toEqual([]);
    expect(merged.staleEnvironments).toEqual(["a"]);
  });
});
