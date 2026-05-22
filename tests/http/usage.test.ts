// tests/http/usage.test.ts
import { describe, it, expect } from "vitest";
import { computeUsageStats } from "../../src/http/usage.js";

const FIXED_NOW = Date.UTC(2026, 4, 22, 12, 0, 0); // 2026-05-22T12:00:00Z

describe("computeUsageStats — empty input", () => {
  it("returns zeroed stats and empty arrays when given no lines and no users", () => {
    const s = computeUsageStats([], [], { now: FIXED_NOW });
    expect(s.totals).toEqual({ today: 0, last7d: 0, last30d: 0 });
    expect(s.activeUsersToday).toBe(0);
    expect(s.failRate7d).toBe(0);
    expect(s.peakReqPerSecLastHour).toBe(0);
    expect(s.rateLimitedTodayBySimpro).toBe(0);
    expect(s.localRateLimitHitsToday).toBe(-1); // sentinel: not measured in v1
    expect(s.perUser).toEqual([]);
    expect(s.hourOfDay).toHaveLength(24);
    expect(s.hourOfDay.every((n) => n === 0)).toBe(true);
    expect(s.dayOfMonth).toHaveLength(31);
    expect(s.dayOfMonth.every((n) => n === 0)).toBe(true);
    expect(s.dayOfWeek).toHaveLength(7);
    expect(s.dayOfWeek.every((n) => n === 0)).toBe(true);
    expect(s.truncated).toBe(false);
  });

  it("lists enrolled users with zero counts even when there are no audit lines", () => {
    const s = computeUsageStats([], ["Tayfun", "Sarah"], { now: FIXED_NOW });
    expect(s.perUser).toHaveLength(2);
    expect(s.perUser.map((u) => u.name).sort()).toEqual(["Sarah", "Tayfun"]);
    for (const u of s.perUser) {
      expect(u.today).toBe(0);
      expect(u.last7d).toBe(0);
      expect(u.last30d).toBe(0);
      expect(u.lastSeenMs).toBeNull();
      expect(u.failRate7d).toBe(0);
      expect(u.topTool).toBeNull();
    }
  });
});
