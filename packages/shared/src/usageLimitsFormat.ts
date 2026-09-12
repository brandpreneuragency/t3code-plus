// @effect-diagnostics globalDate:off -- Limit reset times are wall-clock instants from unix seconds.
/**
 * Display formatting for remaining plan-limit windows.
 *
 * @module usageLimitsFormat
 */

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function resetMillis(resetsAt: number): number {
  return resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
}

function formatDelta(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < hour) return RELATIVE.format(Math.round(deltaMs / minute), "minute");
  if (abs < day) return RELATIVE.format(Math.round(deltaMs / hour), "hour");
  return RELATIVE.format(Math.round(deltaMs / day), "day");
}

export function remainingPercent(usedPercent: number | null): number | null {
  if (usedPercent === null) return null;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

export function formatUsedPercent(usedPercent: number | null): string {
  if (usedPercent === null) return "—";
  const remaining = remainingPercent(usedPercent);
  if (remaining === null) return "—";
  const digits = remaining >= 10 || remaining === 0 ? 0 : 1;
  return `${remaining.toFixed(digits)}% left`;
}

export function formatResetsAt(resetsAt: number | null, nowMs = Date.now()): string | null {
  if (resetsAt === null) return null;
  const resetMs = resetMillis(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const delta = resetMs - nowMs;
  if (delta <= 0) return "reset due";
  return `resets ${formatDelta(delta)}`;
}

export function formatObservedAt(observedAt: string | null, nowMs = Date.now()): string | null {
  if (observedAt === null) return null;
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) return null;
  return `as of ${formatDelta(observedMs - nowMs)}`;
}

export function formatPlanType(planType: string | null): string | null {
  if (planType === null) return null;
  return planType
    .split(/[_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
