import type { EnvironmentId, ModelCatalogueEntry, ModelCatalogueSummary } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { ChevronDownIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { cn } from "../../lib/utils";
import { isElectron } from "../../env";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  filterCatalogueRows,
  formatModelConfidence,
  sortCatalogueRows,
} from "./modelCatalogueRows";

export function ModelCataloguePage() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            <WorkspaceBreadcrumb ariaLabel="Model catalogue breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1>Models</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          {environmentId === null ? (
            <WorkspacePageContainer width="expanded">
              <SetupHint />
            </WorkspacePageContainer>
          ) : (
            <CatalogueEnvironmentView environmentId={environmentId} />
          )}
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function CatalogueEnvironmentView({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(serverEnvironment.modelCatalogue({ environmentId, input: {} }));
  const summary = Option.getOrNull(AsyncResult.value(result));
  const refresh = () =>
    appAtomRegistry.refresh(serverEnvironment.modelCatalogue({ environmentId, input: {} }));

  return (
    <WorkspacePageContainer width="expanded">
      <div className="flex flex-col gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A read-only view of your model research, with local provider availability resolved by this
          environment.
        </p>
      </div>
      {result.waiting && summary === null ? (
        <p className="text-sm text-muted-foreground">Loading model catalogue…</p>
      ) : summary === null ? (
        <StatusPanel message="The model catalogue could not be loaded." onRetry={refresh} />
      ) : (
        <CatalogueSummaryView summary={summary} onRetry={refresh} />
      )}
    </WorkspacePageContainer>
  );
}

function CatalogueSummaryView({
  summary,
  onRetry,
}: {
  readonly summary: ModelCatalogueSummary;
  readonly onRetry: () => void;
}) {
  if (summary.status === "unconfigured") return <SetupHint />;
  if (summary.status === "invalid") {
    return (
      <StatusPanel
        message={summary.message ?? "The model catalogue data is invalid."}
        onRetry={onRetry}
        error
      />
    );
  }
  if (summary.status === "unreachable" && summary.entries.length === 0) {
    return (
      <StatusPanel message="No saved catalogue snapshot is available yet." onRetry={onRetry} />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {summary.status === "unreachable" ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            Showing the last saved snapshot
            {summary.fetchedAt ? ` as of ${formatDate(summary.fetchedAt)}` : ""}.
          </span>
          <Button onClick={onRetry} size="xs" variant="ghost">
            <RefreshCwIcon aria-hidden />
            Retry
          </Button>
        </div>
      ) : null}
      <CatalogueTable summary={summary} />
    </div>
  );
}

function SetupHint() {
  return (
    <div className="flex max-w-xl flex-col gap-2 border border-border/70 bg-muted/20 px-4 py-4">
      <h2 className="text-sm font-medium">Connect your model catalogue</h2>
      <p className="text-sm text-muted-foreground">
        Add the catalogue URL and credentials in{" "}
        <Link
          className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
          to="/settings/integrations"
        >
          Settings → Integrations
        </Link>{" "}
        to browse your model research here.
      </p>
    </div>
  );
}

function StatusPanel({
  message,
  onRetry,
  error = false,
}: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly error?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex max-w-xl flex-col gap-3 border px-4 py-4",
        error ? "border-destructive/30 bg-destructive/6" : "border-border/70",
      )}
    >
      <p className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>
        {message}
      </p>
      <Button className="w-fit" onClick={onRetry} size="sm" variant="outline">
        <RefreshCwIcon aria-hidden />
        Retry
      </Button>
    </div>
  );
}

function CatalogueTable({ summary }: { readonly summary: ModelCatalogueSummary }) {
  const [query, setQuery] = useState("");
  const [availableOnly, setAvailableOnly] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(
    () => sortCatalogueRows(filterCatalogueRows(summary.entries, { query, availableOnly })),
    [availableOnly, query, summary.entries],
  );

  return (
    <section aria-label="Model catalogue" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1 sm:max-w-sm">
          <span className="sr-only">Search models</span>
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search models"
            className="ps-8"
            nativeInput
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search models, ids, or vendors"
            value={query}
          />
        </label>
        <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            aria-label="Show available models only"
            checked={availableOnly}
            className="size-4 accent-primary"
            onChange={(event) => setAvailableOnly(event.currentTarget.checked)}
            type="checkbox"
          />
          Available only
        </label>
        <span className="text-xs tabular-nums text-muted-foreground sm:ms-auto">
          {rows.length} of {summary.entries.length} models
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="border border-border/70 px-4 py-5 text-sm text-muted-foreground">
          No models match these filters.
        </p>
      ) : (
        <div className="min-w-0 overflow-x-auto rounded-md border border-border/70">
          <div className="min-w-[980px]">
            <CatalogueHeader />
            <LegendList<ModelCatalogueEntry>
              className="overflow-y-auto overscroll-y-contain"
              data={rows}
              drawDistance={480}
              estimatedItemSize={92}
              extraData={expanded}
              getItemType={(item) =>
                expanded.has(item.sourceModelId) ? "expanded-model" : "model"
              }
              keyExtractor={(item) => item.sourceModelId}
              recycleItems
              renderItem={({ item }) => (
                <CatalogueRow
                  entry={item}
                  expanded={expanded.has(item.sourceModelId)}
                  onToggle={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(item.sourceModelId)) next.delete(item.sourceModelId);
                      else next.add(item.sourceModelId);
                      return next;
                    })
                  }
                />
              )}
              style={{ height: `min(${Math.max(rows.length, 1) * 100}px, 64dvh, 48rem)` }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

const MODEL_GRID =
  "grid grid-cols-[minmax(210px,1.5fr)_minmax(100px,.7fr)_minmax(145px,1fr)_minmax(88px,.65fr)_minmax(76px,.6fr)_minmax(76px,.6fr)_minmax(155px,1fr)_minmax(92px,.7fr)] items-center gap-3 px-4";

function CatalogueHeader() {
  return (
    <div
      className={cn(
        MODEL_GRID,
        "h-9 border-b border-border/70 bg-muted/25 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
      )}
    >
      <span>Model</span>
      <span>Vendor</span>
      <span>Availability</span>
      <span>Context</span>
      <span>Input / M</span>
      <span>Output / M</span>
      <span>Capabilities</span>
      <span>Confidence</span>
    </div>
  );
}

function CatalogueRow({
  entry,
  expanded,
  onToggle,
}: {
  readonly entry: ModelCatalogueEntry;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        aria-expanded={expanded}
        className={cn(
          MODEL_GRID,
          "min-h-[5.25rem] w-full cursor-pointer text-start text-sm outline-none transition-colors hover:bg-muted/30 focus-visible:bg-muted/40",
        )}
        onClick={onToggle}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
          <span className="min-w-0">
            <span className="block truncate font-medium text-foreground">{entry.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {entry.sourceModelId}
            </span>
          </span>
        </span>
        <span className="truncate text-muted-foreground">{entry.vendorLabel ?? "—"}</span>
        <span className="flex min-w-0 flex-wrap gap-1">
          {entry.availability.length === 0 ? (
            <Badge size="sm" variant="secondary">
              Catalogue only
            </Badge>
          ) : (
            entry.availability.map((match) => (
              <Tooltip key={`${match.instanceId}-${match.model}`}>
                <TooltipTrigger
                  render={
                    <Badge size="sm" variant="success">
                      {match.instanceId}
                    </Badge>
                  }
                />
                <TooltipPopup>Matched by {match.matchedBy}</TooltipPopup>
              </Tooltip>
            ))
          )}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatTokens(entry.contextTokens)}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatPrice(entry.inputPerMillion)}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatPrice(entry.outputPerMillion)}
        </span>
        <span className="flex min-w-0 flex-wrap gap-1 text-xs">
          <Capability value={entry.visionSupport} label="Vision" />
          <Capability value={entry.reasoningSupport} label="Reasoning" />
          <Capability value={entry.parallelAgentSupport} label="Parallel" />
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatModelConfidence(entry.benchmarkConfidence)}
        </span>
      </button>
      {expanded ? (
        <div className="grid grid-cols-1 gap-3 border-t border-border/50 bg-muted/15 px-12 py-3 text-sm sm:grid-cols-2">
          <Detail label="Best for" value={entry.bestUse} />
          <Detail label="Avoid for" value={entry.avoidFor} />
        </div>
      ) : null}
    </div>
  );
}

function Capability({ value, label }: { readonly value: string | null; readonly label: string }) {
  return value === null ? null : (
    <span
      className={cn(
        "rounded px-1.5 py-0.5",
        isNegativeCapability(value)
          ? "bg-muted text-muted-foreground"
          : isPositiveCapability(value)
            ? "bg-success/10 text-success-foreground"
            : "bg-muted text-muted-foreground",
      )}
    >
      {label}: {value}
    </span>
  );
}

function isNegativeCapability(value: string) {
  return ["no", "false", "none", "unsupported", "not supported"].includes(
    value.trim().toLowerCase(),
  );
}

function isPositiveCapability(value: string) {
  return ["yes", "true", "supported"].includes(value.trim().toLowerCase());
}

function Detail({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="whitespace-pre-wrap break-words text-foreground">
        {value ?? "No notes provided."}
      </p>
    </div>
  );
}

function formatTokens(value: number | null) {
  return value === null ? "—" : new Intl.NumberFormat().format(value);
}

function formatPrice(value: number | null) {
  return value === null ? "—" : `$${value.toFixed(value < 1 ? 2 : 0)}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
