import { describe, it, expect } from "vitest";
import { renderBarChart, renderUsageView } from "../../src/http/admin-templates.js";
import type { UsageStats } from "../../src/http/usage.js";

function emptyStats(): UsageStats {
  return {
    totals: { today: 0, last7d: 0, last30d: 0 },
    activeUsersToday: 0,
    failRate7d: 0,
    peakReqPerSecLastHour: 0,
    rateLimitedTodayBySimpro: 0,
    localRateLimitHitsToday: -1,
    perUser: [],
    hourOfDay: Array(24).fill(0),
    dayOfMonth: Array(31).fill(0),
    dayOfWeek: Array(7).fill(0),
    truncated: false,
  };
}

describe("renderBarChart", () => {
  it("emits an <svg> with one <rect> per value", () => {
    const html = renderBarChart([1, 2, 3, 0], { labelEvery: 1, axisLabels: ["a","b","c","d"] });
    expect(html).toContain("<svg");
    expect((html.match(/<rect /g) ?? []).length).toBe(4);
  });

  it("includes the count as a hover title on each bar", () => {
    const html = renderBarChart([7, 0, 5], { labelEvery: 1, axisLabels: ["x","y","z"] });
    expect(html).toContain("<title>7</title>");
    expect(html).toContain("<title>0</title>");
    expect(html).toContain("<title>5</title>");
  });

  it("renders all-zero input without dividing by zero", () => {
    const html = renderBarChart([0, 0, 0], { labelEvery: 1, axisLabels: ["a","b","c"] });
    expect(html).toContain("<svg");
    expect((html.match(/<rect /g) ?? []).length).toBe(3);
  });

  it("places X-axis labels every Nth bar via labelEvery", () => {
    const labels = Array.from({ length: 10 }, (_, i) => String(i));
    const html = renderBarChart(Array(10).fill(1), { labelEvery: 5, axisLabels: labels });
    // Only every 5th label should be rendered as <text>: labels 0 and 5.
    expect(html).toContain(">0<");
    expect(html).toContain(">5<");
    expect(html).not.toContain(">3<");
  });
});

describe("renderUsageView", () => {
  it("renders the admin name, KPI labels, and three SVG charts", () => {
    const html = renderUsageView("Tayfun", emptyStats());
    expect(html).toContain("Tayfun");
    expect(html).toContain("Today");
    expect(html).toContain("Last 7 days");
    expect(html).toContain("Last 30 days");
    expect(html).toContain("Active users today");
    expect(html).toContain("Fail rate");
    expect(html).toContain("Peak req/sec");
    expect(html).toContain("429s from Simpro");
    // Three SVGs for hour/dom/dow charts.
    expect((html.match(/<svg/g) ?? []).length).toBe(3);
  });

  it("renders the per-user table with one row per user", () => {
    const s = emptyStats();
    s.perUser = [
      { name: "Tayfun", calls: 120, lastSeenMs: Date.now(),
        failRate: 0.02, topTool: "simpro_search_jobs" },
      { name: "Sarah",  calls: 5,   lastSeenMs: null,
        failRate: 0,    topTool: null },
    ];
    const html = renderUsageView("Tayfun", s);
    expect(html).toContain("Tayfun");
    expect(html).toContain("Sarah");
    expect(html).toContain("simpro_search_jobs");
    // Sarah has no lastSeen / topTool -> em dash placeholder.
    expect(html.split("Sarah")[1]).toContain("—");
  });

  it("renders localRateLimitHitsToday == -1 as an em dash", () => {
    const html = renderUsageView("Tayfun", emptyStats());
    expect(html).toContain("Local rate-limit hits");
    // The KPI tile for local rate-limit hits should NOT show -1 anywhere.
    expect(html).not.toMatch(/>-1</);
  });

  it("shows a truncated banner when stats.truncated is true", () => {
    const s = emptyStats();
    s.truncated = true;
    const html = renderUsageView("Tayfun", s);
    expect(html.toLowerCase()).toContain("truncated");
  });

  it("shows a 'no activity yet' banner when the dataset is empty", () => {
    const html = renderUsageView("Tayfun", emptyStats());
    expect(html.toLowerCase()).toContain("no activity recorded yet");
  });
});
