// @effect-diagnostics nodeBuiltinImport:off
/**
 * Streams transcripts for the latest remaining-limit snapshot.
 *
 * Isolated here so the rest of the limits code stays on Effect's FileSystem.
 * Same `node:fs` streaming choice as {@link ./usageTranscriptReader.ts}.
 *
 * @module usageLimitsReader
 */
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

import type { UsageProviderKind } from "@t3tools/contracts";

import { mightCarryLimits, parseLimitLine, type ParsedUsageLimitSnapshot } from "./usageLimits.ts";

export async function readLatestLimitSnapshot(
  filePath: string,
  provider: UsageProviderKind,
): Promise<ParsedUsageLimitSnapshot | null> {
  let latest: ParsedUsageLimitSnapshot | null = null;

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!mightCarryLimits(line, provider)) continue;
      const parsed = parseLimitLine(line, provider);
      if (parsed === null) continue;
      if (latest === null || parsed.timestampMs >= latest.timestampMs) latest = parsed;
    }
  } catch {
    return null;
  }

  return latest;
}
