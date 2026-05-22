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

describe("computeUsageStats — activeUsersToday + failRate7d", () => {
  it("counts distinct users with >=1 call in today, ignores users with only older calls", () => {
    const now = FIXED_NOW;
    const mk = (user: string, ageMs: number) =>
      JSON.stringify({
        ts: new Date(now - ageMs).toISOString(),
        user, company: "plumbing", tool: "simpro_search_jobs",
        ok: true, durationMs: 1,
      });
    const lines = [
      mk("Tayfun", 60 * 60 * 1000),       // 1h ago
      mk("Sarah",  2 * 60 * 60 * 1000),   // 2h ago
      mk("Tayfun", 3 * 60 * 60 * 1000),   // 3h ago (still today; duplicate user)
      mk("Jamie",  2 * ONE_DAY_MS),       // 2d ago (not today)
    ];
    const s = computeUsageStats(lines, [], { now });
    expect(s.activeUsersToday).toBe(2); // Tayfun + Sarah
  });

  it("computes failRate7d as failures / total within last 7 days, 3 dp", () => {
    const now = FIXED_NOW;
    const mk = (ageMs: number, ok: boolean) =>
      JSON.stringify({
        ts: new Date(now - ageMs).toISOString(),
        user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
        ok, durationMs: 1,
      });
    const lines = [
      mk(60 * 60 * 1000, true),
      mk(60 * 60 * 1000, true),
      mk(60 * 60 * 1000, true),
      mk(60 * 60 * 1000, false),  // 1 of 4 -> 0.25
      mk(40 * ONE_DAY_MS, false), // outside 7d -> ignored
    ];
    const s = computeUsageStats(lines, [], { now });
    expect(s.failRate7d).toBeCloseTo(0.25, 3);
  });

  it("failRate7d is 0 when there are no calls in the last 7 days", () => {
    const s = computeUsageStats([], [], { now: FIXED_NOW });
    expect(s.failRate7d).toBe(0);
  });
});

describe("computeUsageStats — peakReqPerSecLastHour", () => {
  it("returns the max calls-per-second over the last hour", () => {
    const now = FIXED_NOW;
    // 8 calls all in the same second, 5 minutes ago
    const base = now - 5 * 60 * 1000;
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(JSON.stringify({
        ts: new Date(base + i * 10).toISOString(), // within same second
        user: "Tayfun", company: "plumbing", tool: "simpro_search_jobs",
        ok: true, durationMs: 1,
      }));
    }
    const s = computeUsageStats(lines, [], { now });
    expect(s.peakReqPerSecLastHour).toBe(8);
  });

  it("returns 1 when 8 calls are spread across 8 different seconds", () => {
    const now = FIXED_NOW;
    const base = now - 10 * 60 * 1000;
    const lines = [];
    for (let i = 0; i < 8; i++) {
      lines.push(JSON.stringify({
        ts: new Date(base + i * 1000).toISOString(), // one per second
        user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
        ok: true, durationMs: 1,
      }));
    }
    const s = computeUsageStats(lines, [], { now });
    expect(s.peakReqPerSecLastHour).toBe(1);
  });

  it("ignores calls older than the last hour", () => {
    const now = FIXED_NOW;
    const lines = [JSON.stringify({
      ts: new Date(now - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
      ok: true, durationMs: 1,
    })];
    const s = computeUsageStats(lines, [], { now });
    expect(s.peakReqPerSecLastHour).toBe(0);
  });
});

describe("computeUsageStats — rateLimitedTodayBySimpro", () => {
  it("counts failed rows whose errorMessage matches /rate limit/i within today", () => {
    const now = FIXED_NOW;
    const mk = (ageMs: number, ok: boolean, errorMessage?: string) =>
      JSON.stringify({
        ts: new Date(now - ageMs).toISOString(),
        user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
        ok, durationMs: 1, errorMessage,
      });
    const lines = [
      mk(60_000, false, "Rate limited by Simpro — wait a moment and try again."),
      mk(60_000, false, "Some other error"),
      mk(60_000, true),
      mk(2 * ONE_DAY_MS, false, "Rate limited by Simpro"), // outside today
    ];
    const s = computeUsageStats(lines, [], { now });
    expect(s.rateLimitedTodayBySimpro).toBe(1);
  });

  it("is 0 when no failed rows match the rate-limit pattern", () => {
    const now = FIXED_NOW;
    const lines = [JSON.stringify({
      ts: new Date(now - 60_000).toISOString(),
      user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
      ok: false, durationMs: 1, errorMessage: "Not found.",
    })];
    const s = computeUsageStats(lines, [], { now });
    expect(s.rateLimitedTodayBySimpro).toBe(0);
  });
});

describe("computeUsageStats — perUser", () => {
  it("aggregates per-user counts, lastSeen, failRate, and topTool, sorted by last30d desc", () => {
    const now = FIXED_NOW;
    const mk = (user: string, ageMs: number, tool: string, ok = true) =>
      JSON.stringify({
        ts: new Date(now - ageMs).toISOString(),
        user, company: "plumbing", tool, ok, durationMs: 1,
      });
    const lines = [
      mk("Tayfun", 60_000, "simpro_search_jobs"),
      mk("Tayfun", 2 * 60 * 60 * 1000, "simpro_search_jobs"),
      mk("Tayfun", 3 * ONE_DAY_MS, "simpro_get_job"),
      mk("Tayfun", 5 * ONE_DAY_MS, "simpro_search_jobs", false),
      mk("Sarah",  60_000, "simpro_get_invoice"),
    ];
    const s = computeUsageStats(lines, ["Tayfun", "Sarah", "Jamie"], { now });

    expect(s.perUser.map((u) => u.name)).toEqual(["Tayfun", "Sarah", "Jamie"]);

    const t = s.perUser[0];
    expect(t.today).toBe(2);
    expect(t.last7d).toBe(4);
    expect(t.last30d).toBe(4);
    expect(t.lastSeenMs).toBe(now - 60_000);
    expect(t.failRate7d).toBeCloseTo(0.25, 3); // 1 fail of 4
    expect(t.topTool).toBe("simpro_search_jobs"); // appears 3 times

    const sarah = s.perUser[1];
    expect(sarah.today).toBe(1);
    expect(sarah.topTool).toBe("simpro_get_invoice");

    const jamie = s.perUser[2]; // enrolled but no activity
    expect(jamie.today).toBe(0);
    expect(jamie.lastSeenMs).toBeNull();
    expect(jamie.topTool).toBeNull();
  });

  it("includes a user who appears in lines but isn't in knownUsers (e.g. revoked)", () => {
    const now = FIXED_NOW;
    const line = JSON.stringify({
      ts: new Date(now - 60_000).toISOString(),
      user: "Ghost", company: "plumbing", tool: "simpro_get_job",
      ok: true, durationMs: 1,
    });
    const s = computeUsageStats([line], ["Tayfun"], { now });
    const names = s.perUser.map((u) => u.name);
    expect(names).toContain("Ghost");
    expect(names).toContain("Tayfun");
  });
});

describe("computeUsageStats — time-pattern buckets", () => {
  it("buckets hourOfDay using local time over the last 30 days", () => {
    const now = FIXED_NOW;
    // 3 calls at local 09:xx, 1 call at local 14:xx, within last 30 days.
    const mk = (hour: number) => {
      const d = new Date(now - 60_000);
      d.setHours(hour, 30, 0, 0); // mutate to a specific local hour
      return JSON.stringify({
        ts: d.toISOString(),
        user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
        ok: true, durationMs: 1,
      });
    };
    const s = computeUsageStats([mk(9), mk(9), mk(9), mk(14)], [], { now });
    expect(s.hourOfDay[9]).toBe(3);
    expect(s.hourOfDay[14]).toBe(1);
    expect(s.hourOfDay.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("buckets dayOfMonth (1..31 -> index 0..30) over the last 90 days", () => {
    const now = FIXED_NOW;
    const d = new Date(now);
    d.setDate(15); // 15th of the month
    const line = JSON.stringify({
      ts: d.toISOString(),
      user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
      ok: true, durationMs: 1,
    });
    const s = computeUsageStats([line], [], { now });
    expect(s.dayOfMonth[14]).toBe(1); // index = day-1
    expect(s.dayOfMonth.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("buckets dayOfWeek with Mon=0 .. Sun=6", () => {
    const now = FIXED_NOW;
    const line = JSON.stringify({
      ts: new Date(now - 60_000).toISOString(),
      user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
      ok: true, durationMs: 1,
    });
    const s = computeUsageStats([line], [], { now });
    // The day of FIXED_NOW in server local time. Compute the expected bucket
    // dynamically so this test is TZ-stable.
    const jsDay = new Date(now - 60_000).getDay(); // 0=Sun..6=Sat
    const expected = (jsDay + 6) % 7; // 0=Mon..6=Sun
    expect(s.dayOfWeek[expected]).toBe(1);
    expect(s.dayOfWeek.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("excludes rows outside the bucket windows (>30d for hour/dow, >90d for dom)", () => {
    const now = FIXED_NOW;
    const old = JSON.stringify({
      ts: new Date(now - 100 * ONE_DAY_MS).toISOString(),
      user: "Tayfun", company: "plumbing", tool: "simpro_get_job",
      ok: true, durationMs: 1,
    });
    const s = computeUsageStats([old], [], { now });
    expect(s.hourOfDay.reduce((a, b) => a + b, 0)).toBe(0);
    expect(s.dayOfMonth.reduce((a, b) => a + b, 0)).toBe(0);
    expect(s.dayOfWeek.reduce((a, b) => a + b, 0)).toBe(0);
  });
});
