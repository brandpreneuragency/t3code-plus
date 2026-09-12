/**
 * Multi-environment remaining-limit state.
 *
 * Mirror of `apps/web/src/state/usageLimits.ts`.
 *
 * @module state/usageLimits
 */
import { useAtomValue } from "@effect/atom-react";
import {
  USAGE_LIMITS_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageLimitsSummary,
} from "@t3tools/contracts";
import {
  mergeUsageLimits,
  type EnvironmentUsageLimits,
  type MergedUsageLimits,
} from "@t3tools/shared/usageLimitsMerge";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentUsageLimitsStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageLimitsSummary | null;
}

const usageLimitsAtom = Atom.make((get): readonly EnvironmentUsageLimitsStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentUsageLimitsStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.usageLimits({ environmentId, input: {} }));
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error: result._tag === "Failure" ? "This environment could not report limits." : null,
      summary: Option.getOrNull(AsyncResult.value(result)),
    });
  }
  return statuses;
}).pipe(Atom.withLabel("mobile-usage-limits"));

export interface UsageLimitsView {
  readonly merged: MergedUsageLimits;
  readonly environments: readonly EnvironmentUsageLimitsStatus[];
  readonly isPending: boolean;
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useUsageLimits(): UsageLimitsView {
  const environments = useAtomValue(usageLimitsAtom);

  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.usageLimits({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);

  const merged = (() => {
    const answered: EnvironmentUsageLimits[] = environments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: environment.summary,
            },
          ],
    );
    return mergeUsageLimits(answered, USAGE_LIMITS_CONTRACT_VERSION);
  })();

  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
