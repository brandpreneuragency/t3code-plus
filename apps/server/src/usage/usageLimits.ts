/**
 * Pure parsers for remaining plan-limit snapshots in provider transcripts.
 *
 * @module usageLimits
 */
import type { UsageLimitWindow, UsageProviderKind } from "@t3tools/contracts";

export interface ParsedUsageLimitSnapshot {
  readonly timestampMs: number;
  readonly planType: string | null;
  readonly windows: readonly UsageLimitWindow[];
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  return null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function labelForLimitWindow(windowMinutes: number | null, id: string): string {
  if (id === "primary" || id === "five_hour" || windowMinutes === 300) return "5-hour";
  if (id === "secondary" || id === "seven_day" || id === "weekly" || windowMinutes === 10080) {
    return "Weekly";
  }
  if (id === "daily" || windowMinutes === 1440) return "Daily";
  if (windowMinutes !== null && windowMinutes > 0) {
    if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}-day`;
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour`;
    return `${windowMinutes} min`;
  }
  return id.replaceAll("_", " ");
}

export function mightCarryLimits(line: string, provider: UsageProviderKind): boolean {
  if (provider === "codex") return line.includes("rate_limits") || line.includes("rateLimits");
  if (provider === "claude") {
    return line.includes("quotaLimits") || line.includes("rate_limit_event");
  }
  return false;
}

function readWindow(value: unknown, id: string): UsageLimitWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const usedPercent = readNumber(record["usedPercent"] ?? record["used_percent"]);
  const windowMinutes = readNumber(
    record["windowDurationMins"] ?? record["window_minutes"] ?? record["windowMinutes"],
  );
  const resetsAt = readNumber(record["resetsAt"] ?? record["resets_at"]);
  if (usedPercent === null && resetsAt === null && windowMinutes === null) return null;
  const clamped = usedPercent === null ? null : Math.min(100, Math.max(0, usedPercent));
  const minutes = windowMinutes === null ? null : Math.max(0, Math.trunc(windowMinutes));
  return {
    id,
    label: labelForLimitWindow(minutes, id),
    usedPercent: clamped,
    windowMinutes: minutes,
    resetsAt: resetsAt === null ? null : Math.trunc(resetsAt),
    reached: (clamped ?? 0) >= 100,
  };
}

function readPlanType(value: unknown): string | null {
  return readString(value);
}

export function parseCodexLimitLine(line: string): ParsedUsageLimitSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const limits = payloadRecord["rate_limits"] ?? payloadRecord["rateLimits"];
  if (typeof limits !== "object" || limits === null) return null;
  const limitsRecord = limits as Record<string, unknown>;
  const windows = [
    readWindow(limitsRecord["primary"], "primary"),
    readWindow(limitsRecord["secondary"], "secondary"),
  ].filter((window): window is UsageLimitWindow => window !== null);
  if (windows.length === 0) return null;
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  return {
    timestampMs,
    planType: readPlanType(limitsRecord["plan_type"] ?? limitsRecord["planType"]),
    windows,
  };
}

function readClaudeWindows(record: Record<string, unknown>): UsageLimitWindow[] {
  const nested = record["rate_limits"] ?? record["rateLimits"];
  if (typeof nested === "object" && nested !== null) {
    const nestedRecord = nested as Record<string, unknown>;
    const windows = [
      readWindow(nestedRecord["primary"], "primary"),
      readWindow(nestedRecord["secondary"], "secondary"),
    ].filter((window): window is UsageLimitWindow => window !== null);
    if (windows.length > 0) return windows;
  }

  const quota = record["quotaLimits"];
  if (typeof quota === "object" && quota !== null) {
    const quotaRecord = quota as Record<string, unknown>;
    const id =
      readString(quotaRecord["rateLimitType"] ?? quotaRecord["rate_limit_type"]) ?? "quota";
    const resetsAt = readNumber(quotaRecord["resetsAt"] ?? quotaRecord["resets_at"]);
    const status = readString(quotaRecord["status"]);
    const reached = status === "rejected" || status === "exceeded";
    return [
      {
        id,
        label: labelForLimitWindow(null, id),
        usedPercent: reached ? 100 : null,
        windowMinutes: id === "five_hour" ? 300 : id === "seven_day" ? 10080 : null,
        resetsAt: resetsAt === null ? null : Math.trunc(resetsAt),
        reached,
      },
    ];
  }

  const direct = readWindow(record, readString(record["rateLimitType"]) ?? "quota");
  return direct === null ? [] : [direct];
}

export function parseClaudeLimitLine(line: string): ParsedUsageLimitSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const isEvent = record["type"] === "rate_limit_event";
  const hasQuota = typeof record["quotaLimits"] === "object" && record["quotaLimits"] !== null;
  if (!isEvent && !hasQuota) return null;
  const windows = readClaudeWindows(record);
  if (windows.length === 0) return null;
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  return {
    timestampMs,
    planType: readPlanType(record["planType"] ?? record["plan_type"]),
    windows,
  };
}

export function parseLimitLine(
  line: string,
  provider: UsageProviderKind,
): ParsedUsageLimitSnapshot | null {
  if (provider === "codex") return parseCodexLimitLine(line);
  if (provider === "claude") return parseClaudeLimitLine(line);
  return null;
}
