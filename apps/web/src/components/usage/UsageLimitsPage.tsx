import { useNavigate } from "@tanstack/react-router";
import type { UsageProviderKind } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";

import {
  formatObservedAt,
  formatPlanType,
  formatResetsAt,
  formatUsedPercent,
} from "@t3tools/shared/usageLimitsFormat";
import type { MergedUsageLimitProvider } from "@t3tools/shared/usageLimitsMerge";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useUsageLimits, type EnvironmentUsageLimitsStatus } from "../../state/usageLimits";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

export function UsageLimitsPage() {
  const navigate = useNavigate();
  const { merged, environments, isPending, isPartial, refresh } = useUsageLimits();
  const settling = isPending || isPartial;
  const showEnvironmentLabels = merged.contributingEnvironments.length > 1;
  const grouped = useMemo(() => groupByEnvironment(merged.providers), [merged.providers]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            <WorkspaceBreadcrumb ariaLabel="Limits breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1>Limits</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="ms-auto flex min-w-0 items-center justify-end gap-1">
              <Button onClick={() => void navigate({ to: "/usage" })} size="sm" variant="ghost">
                Usage
              </Button>
              <Button onClick={refresh} aria-label="Refresh limits" size="icon-sm" variant="ghost">
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="readable">
            {settling ? (
              <p className="text-sm text-muted-foreground">Reading provider session files…</p>
            ) : (
              <>
                <LimitsCoverageNotice
                  environments={environments}
                  duplicateSources={merged.duplicateSources}
                  staleEnvironments={merged.staleEnvironments}
                />
                <p className="text-sm text-muted-foreground">
                  Last-seen plan windows from local session files. These are not live account
                  queries, and they update after a provider turn writes a snapshot.
                </p>
                {environments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Connect an environment to see remaining limits.
                  </p>
                ) : grouped.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No provider limit snapshots on the connected environments.
                  </p>
                ) : (
                  <div className="flex flex-col gap-8">
                    {grouped.map((group) => (
                      <section key={group.environmentId} className="flex flex-col gap-3">
                        {showEnvironmentLabels ? (
                          <h2 className="text-sm font-medium text-foreground">
                            {group.environmentLabel}
                          </h2>
                        ) : null}
                        {PROVIDER_ORDER.map((provider) => {
                          const snapshot = group.providers.find(
                            (entry) => entry.provider === provider,
                          );
                          if (snapshot === undefined) return null;
                          return <ProviderLimitCard key={provider} snapshot={snapshot} />;
                        })}
                      </section>
                    ))}
                  </div>
                )}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function groupByEnvironment(providers: readonly MergedUsageLimitProvider[]): readonly {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly providers: readonly MergedUsageLimitProvider[];
}[] {
  const groups: {
    environmentId: string;
    environmentLabel: string;
    providers: MergedUsageLimitProvider[];
  }[] = [];
  for (const snapshot of providers) {
    const existing = groups.find((group) => group.environmentId === snapshot.environmentId);
    if (existing === undefined) {
      groups.push({
        environmentId: snapshot.environmentId,
        environmentLabel: snapshot.environmentLabel,
        providers: [snapshot],
      });
      continue;
    }
    existing.providers.push(snapshot);
  }
  return groups;
}

function ProviderLimitCard({ snapshot }: { readonly snapshot: MergedUsageLimitProvider }) {
  const presentation = PROVIDER_PRESENTATION[snapshot.provider];
  const Mark = presentation.mark;
  const plan = formatPlanType(snapshot.planType);
  const observed = formatObservedAt(snapshot.observedAt);

  return (
    <article className="flex flex-col gap-3 border border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Mark className="size-4 shrink-0" aria-hidden />
        <h3 className="text-sm font-medium text-foreground">{presentation.label}</h3>
        {plan !== null ? <span className="text-xs text-muted-foreground">{plan}</span> : null}
        {observed !== null ? (
          <span className="ms-auto text-xs text-muted-foreground">{observed}</span>
        ) : null}
      </div>
      {snapshot.status === "ok" && snapshot.windows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {snapshot.windows.map((window) => (
            <LimitWindowRow key={window.id} window={window} provider={snapshot.provider} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {snapshot.message ?? "No recent limit snapshot."}
        </p>
      )}
    </article>
  );
}

function LimitWindowRow({
  window,
  provider,
}: {
  readonly window: MergedUsageLimitProvider["windows"][number];
  readonly provider: UsageProviderKind;
}) {
  const used = window.usedPercent;
  const width = used === null ? 0 : Math.min(100, Math.max(0, used));
  const reset = formatResetsAt(window.resetsAt);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
        <span className="text-foreground">{window.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {window.reached ? "Limit reached" : formatUsedPercent(used)}
          {reset !== null ? ` · ${reset}` : ""}
        </span>
      </div>
      <div
        aria-label={`${PROVIDER_PRESENTATION[provider].label} ${window.label} usage`}
        className="h-1.5 w-full overflow-hidden bg-muted"
      >
        <div
          className={cn("h-full", window.reached ? "bg-destructive" : "bg-foreground")}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function LimitsCoverageNotice({
  environments,
  duplicateSources,
  staleEnvironments,
}: {
  readonly environments: readonly EnvironmentUsageLimitsStatus[];
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const stale = environments.filter((environment) =>
    staleEnvironments.includes(environment.environmentId),
  );
  if (failed.length === 0 && stale.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border border-border px-3 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>{environment.label} could not report limits.</span>
      ))}
      {stale.map((environment) => (
        <span key={environment.label}>
          {environment.label} runs an older server version and is excluded.
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}
