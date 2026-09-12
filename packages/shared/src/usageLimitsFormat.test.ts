import { describe, expect, it } from "vite-plus/test";

import {
  formatObservedAt,
  formatPlanType,
  formatResetsAt,
  formatUsedPercent,
  remainingPercent,
} from "./usageLimitsFormat.ts";

describe("remainingPercent", () => {
  it("inverts used percent", () => {
    expect(remainingPercent(7)).toBe(93);
    expect(remainingPercent(100)).toBe(0);
    expect(remainingPercent(null)).toBeNull();
  });
});

describe("formatUsedPercent", () => {
  it("shows remaining capacity", () => {
    expect(formatUsedPercent(7)).toBe("93% left");
    expect(formatUsedPercent(100)).toBe("0% left");
    expect(formatUsedPercent(null)).toBe("—");
  });
});

describe("formatResetsAt", () => {
  it("describes a future reset", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const resetsAt = Date.parse("2026-09-02T17:00:00.000Z") / 1000;
    expect(formatResetsAt(resetsAt, now)).toBe("resets in 5 hours");
  });

  it("marks a due reset", () => {
    expect(formatResetsAt(1, Date.parse("2026-09-02T12:00:00.000Z"))).toBe("reset due");
  });
});

describe("formatObservedAt", () => {
  it("describes how old the snapshot is", () => {
    const now = Date.parse("2026-09-02T12:30:00.000Z");
    expect(formatObservedAt("2026-09-02T12:00:00.000Z", now)).toBe("as of 30 minutes ago");
  });
});

describe("formatPlanType", () => {
  it("title-cases provider plan ids", () => {
    expect(formatPlanType("plus")).toBe("Plus");
    expect(formatPlanType("pro_lite")).toBe("Pro Lite");
    expect(formatPlanType(null)).toBeNull();
  });
});
