import { describe, expect, it } from "vite-plus/test";

import { labelForLimitWindow, parseClaudeLimitLine, parseCodexLimitLine } from "./usageLimits.ts";

describe("parseCodexLimitLine", () => {
  it("reads primary and secondary windows from a token_count event", () => {
    const line = JSON.stringify({
      timestamp: "2026-09-02T17:28:30.179Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 7.0, window_minutes: 300, resets_at: 1788380391 },
          secondary: { used_percent: 1.0, window_minutes: 10080, resets_at: 1788967191 },
          plan_type: "plus",
          rate_limit_reached_type: null,
        },
      },
    });

    const snapshot = parseCodexLimitLine(line);
    expect(snapshot?.planType).toBe("plus");
    expect(snapshot?.windows).toEqual([
      {
        id: "primary",
        label: "5-hour",
        usedPercent: 7,
        windowMinutes: 300,
        resetsAt: 1788380391,
        reached: false,
      },
      {
        id: "secondary",
        label: "Weekly",
        usedPercent: 1,
        windowMinutes: 10080,
        resetsAt: 1788967191,
        reached: false,
      },
    ]);
  });

  it("ignores token_count events without rate_limits", () => {
    expect(
      parseCodexLimitLine(
        JSON.stringify({
          timestamp: "2026-09-02T17:28:30.179Z",
          type: "event_msg",
          payload: { type: "token_count" },
        }),
      ),
    ).toBeNull();
  });
});

describe("parseClaudeLimitLine", () => {
  it("reads a blocked quota snapshot", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-21T10:45:18.555Z",
      quotaLimits: {
        status: "rejected",
        resetsAt: 1787311800,
        rateLimitType: "five_hour",
      },
      error: "rate_limit",
    });

    const snapshot = parseClaudeLimitLine(line);
    expect(snapshot?.windows).toEqual([
      {
        id: "five_hour",
        label: "5-hour",
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: 1787311800,
        reached: true,
      },
    ]);
  });

  it("ignores ordinary assistant records", () => {
    expect(
      parseClaudeLimitLine(
        JSON.stringify({ type: "assistant", timestamp: "2026-08-21T10:45:18.555Z" }),
      ),
    ).toBeNull();
  });
});

describe("labelForLimitWindow", () => {
  it("names the common Codex windows", () => {
    expect(labelForLimitWindow(300, "primary")).toBe("5-hour");
    expect(labelForLimitWindow(10080, "secondary")).toBe("Weekly");
  });
});
