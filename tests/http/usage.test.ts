// tests/http/usage.test.ts
import { describe, it, expect } from "vitest";
import { computeUsageStats } from "../../src/http/usage.js";

const FIXED_NOW = Date.UTC(2026, 4, 22, 12, 0, 0); // 2026-05-22T12:00:00Z
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

describe("computeUsageStats — totals", () => {
  it("counts entries into rolling 24h / 7d / 30d windows", () => {
    const now = FIXED_NOW;
    const mk = (ageMs: number, ok = true) =>
      JSON.stringify({
        ts: new Date(now - ageMs).toISOString(),
        user: "Tayfun", company: "plumbing", tool: "simpro_search_jobs",
        ok, durationMs: 100,
      });
    const lines = [
      mk(60 * 60 * 1000),               // 1h ago -> today + 7d + 30d
      mk(5 * 24 * 60 * 60 * 1000),      // 5d ago -> 7d + 30d
      mk(25 * 24 * 60 * 60 * 1000),     // 25d ago -> 30d
      mk(35 * 24 * 60 * 60 * 1000),     // 35d ago -> none
    ];
    const s = computeUsageStats(lines, ["Tayfun"], { now });
    expect(s.totals.today).toBe(1);
    expect(s.totals.last7d).toBe(2);
    expect(s.totals.last30d).toBe(3);
  });

  it("treats exactly-24h-old as outside today, and 23h59m59s as inside", () => {
    const now = FIXED_NOW;
    const mk = (ageMs: number) =>
      JSON.stringify({
        ts: new Date(now - ageMs).toISOString(),
        user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
        ok: true, durationMs: 50,
      });
    const inWindow = mk(24 * 60 * 60 * 1000 - 1000);    // 23h59m59s
    const onCutoff = mk(24 * 60 * 60 * 1000);           // exactly 24h
    const outside = mk(24 * 60 * 60 * 1000 + 1000);     // 24h + 1s
    const s = computeUsageStats([inWindow, onCutoff, outside], ["Tayfun"], { now });
    expect(s.totals.today).toBe(1); // only the 23h59m59s entry
  });

  it("ignores malformed lines instead of throwing", () => {
    const lines = [
      "not json at all",
      JSON.stringify({ ts: "garbage" }),
      JSON.stringify({ user: "x" }), // missing ts and tool
      JSON.stringify({
        ts: new Date(FIXED_NOW - 1000).toISOString(),
        user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
        ok: true, durationMs: 1,
      }),
    ];
    const s = computeUsageStats(lines, [], { now: FIXED_NOW });
    expect(s.totals.today).toBe(1);
  });
});
