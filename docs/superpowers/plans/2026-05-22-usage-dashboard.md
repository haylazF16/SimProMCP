# Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin-only `/admin/usage` page that surfaces KPI tiles, per-user counts, and three time-pattern bar charts — all derived from the existing audit log + tokens.json. Read-only analytics, no enforced quotas, no warning messages.

**Architecture:** A pure aggregator (`usage.ts`) takes audit lines + the list of enrolled users and returns a fully-typed `UsageStats` object. A thin route handler (`usageRoute.ts`) loads the inputs and calls the aggregator. A new `renderUsageView` in `admin-templates.ts` produces the HTML, including hand-rolled SVG bar charts. No new dependencies, no schema changes, no persisted state.

**Tech Stack:** TypeScript ESM strict (existing project), Express 4, vitest, supertest. Reuses the existing `auditReader.readRange` helper for loading audit history.

**Source spec:** `docs/superpowers/specs/2026-05-22-usage-dashboard-design.md`

**Branch:** `feat/http-transport` (existing). After this lands the existing 79 tests + ~13 new tests must all pass.

---

## File structure

```
src/http/
├── usage.ts          (NEW) pure aggregator: lines + knownUsers -> UsageStats
├── usageRoute.ts     (NEW) Express handler: loads inputs, calls aggregator, renders
├── admin.ts          (MOD) attach the new route; existing requireAdmin reused
└── admin-templates.ts (MOD) +renderUsageView, +renderBarChart helper, +"Usage" nav link

tests/http/
├── usage.test.ts       (NEW) ~10 unit tests for pure aggregator
└── usageRoute.test.ts  (NEW) ~3 supertest integration tests for the route
```

Each file has one clear responsibility:
- `usage.ts` does **only** the math. No I/O. No HTML. Easy to test.
- `usageRoute.ts` does **only** the wiring. No math. No HTML rendering logic of its own.
- `admin-templates.ts` does **only** HTML generation. No file I/O.

---

## Task 1: Type contract + empty-state aggregator

**Files:**
- Create: `src/http/usage.ts`
- Create: `tests/http/usage.test.ts`

- [ ] **Step 1.1: Create the test file with the empty-input case**

`tests/http/usage.test.ts`:
```ts
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
```

- [ ] **Step 1.2: Run the test and watch it fail**

Run: `npx vitest run tests/http/usage.test.ts`
Expected: FAIL — `Cannot find module '../../src/http/usage.js'`

- [ ] **Step 1.3: Create the minimal `usage.ts` to make Step 1.1 pass**

`src/http/usage.ts`:
```ts
// src/http/usage.ts
// Pure aggregator: turns audit JSONL lines + list of enrolled user names
// into a UsageStats projection. No I/O, no HTML. Caller (usageRoute.ts)
// is responsible for loading the inputs.

export interface PerUserStats {
  name: string;
  today: number;
  last7d: number;
  last30d: number;
  lastSeenMs: number | null;
  failRate7d: number;     // 0..1, 3 decimals
  topTool: string | null;
}

export interface UsageStats {
  totals: { today: number; last7d: number; last30d: number };
  activeUsersToday: number;
  failRate7d: number;     // 0..1
  peakReqPerSecLastHour: number;
  rateLimitedTodayBySimpro: number;
  /** Sentinel: -1 means "not measured in v1". Renderer maps -1 to "—". */
  localRateLimitHitsToday: number;
  perUser: PerUserStats[];
  /** Counts by hour-of-day (server local time), 24 elements. Last 30 days. */
  hourOfDay: number[];
  /** Counts by day-of-month 1..31 (index 0..30). Last 90 days. */
  dayOfMonth: number[];
  /** Counts by day-of-week, Mon=0 .. Sun=6. Last 30 days. */
  dayOfWeek: number[];
  /** Mirrors auditReader.readRange's truncated flag — surfaced for UI. */
  truncated: boolean;
}

export interface ComputeOpts {
  /** Override "now" for tests; defaults to Date.now(). */
  now?: number;
  /** Was the audit-line set truncated upstream? */
  truncated?: boolean;
}

export function computeUsageStats(
  _lines: string[],
  knownUsers: string[],
  opts: ComputeOpts = {},
): UsageStats {
  const perUser: PerUserStats[] = knownUsers.map((name) => ({
    name,
    today: 0,
    last7d: 0,
    last30d: 0,
    lastSeenMs: null,
    failRate7d: 0,
    topTool: null,
  }));
  return {
    totals: { today: 0, last7d: 0, last30d: 0 },
    activeUsersToday: 0,
    failRate7d: 0,
    peakReqPerSecLastHour: 0,
    rateLimitedTodayBySimpro: 0,
    localRateLimitHitsToday: -1,
    perUser,
    hourOfDay: Array(24).fill(0),
    dayOfMonth: Array(31).fill(0),
    dayOfWeek: Array(7).fill(0),
    truncated: opts.truncated === true,
  };
}
```

- [ ] **Step 1.4: Run the test and watch it pass**

Run: `npx vitest run tests/http/usage.test.ts`
Expected: PASS — 2/2 tests green.

- [ ] **Step 1.5: Typecheck**

Run: `npm run typecheck`
Expected: clean (zero errors).

- [ ] **Step 1.6: Commit**

```bash
git add src/http/usage.ts tests/http/usage.test.ts
git commit -m "feat(usage): scaffold pure aggregator + empty-state tests"
```

---

## Task 2: Volume totals (today / 7d / 30d)

**Files:**
- Modify: `src/http/usage.ts`
- Modify: `tests/http/usage.test.ts`

- [ ] **Step 2.1: Add the volume-totals test**

Append to `tests/http/usage.test.ts`:
```ts
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
```

- [ ] **Step 2.2: Run it and watch the new tests fail**

Run: `npx vitest run tests/http/usage.test.ts`
Expected: FAIL on the three new tests (totals still 0).

- [ ] **Step 2.3: Implement parsing + totals in `usage.ts`**

Replace the body of `computeUsageStats` in `src/http/usage.ts`:
```ts
interface Row {
  ts: number;
  user: string;
  company: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  errorMessage?: string;
}

function parseLine(raw: string): Row | null {
  try {
    const o = JSON.parse(raw) as Partial<Row> & { ts?: string };
    if (typeof o.ts !== "string" || typeof o.tool !== "string") return null;
    const ts = Date.parse(o.ts);
    if (!Number.isFinite(ts)) return null;
    return {
      ts,
      user: typeof o.user === "string" ? o.user : "unknown",
      company: typeof o.company === "string" ? o.company : "—",
      tool: o.tool,
      ok: o.ok !== false,
      durationMs: typeof o.durationMs === "number" ? o.durationMs : 0,
      errorMessage: typeof o.errorMessage === "string" ? o.errorMessage : undefined,
    };
  } catch {
    return null;
  }
}

const ONE_DAY = 24 * 60 * 60 * 1000;
```

Then rewrite `computeUsageStats` itself:
```ts
export function computeUsageStats(
  lines: string[],
  knownUsers: string[],
  opts: ComputeOpts = {},
): UsageStats {
  const now = opts.now ?? Date.now();
  const cutToday = now - ONE_DAY;
  const cut7d    = now - 7 * ONE_DAY;
  const cut30d   = now - 30 * ONE_DAY;

  const rows: Row[] = [];
  for (const raw of lines) {
    const r = parseLine(raw);
    if (r) rows.push(r);
  }

  let today = 0, last7d = 0, last30d = 0;
  for (const r of rows) {
    if (r.ts > cutToday)  today++;
    if (r.ts > cut7d)     last7d++;
    if (r.ts > cut30d)    last30d++;
  }

  const perUser: PerUserStats[] = knownUsers.map((name) => ({
    name,
    today: 0,
    last7d: 0,
    last30d: 0,
    lastSeenMs: null,
    failRate7d: 0,
    topTool: null,
  }));

  return {
    totals: { today, last7d, last30d },
    activeUsersToday: 0,
    failRate7d: 0,
    peakReqPerSecLastHour: 0,
    rateLimitedTodayBySimpro: 0,
    localRateLimitHitsToday: -1,
    perUser,
    hourOfDay: Array(24).fill(0),
    dayOfMonth: Array(31).fill(0),
    dayOfWeek: Array(7).fill(0),
    truncated: opts.truncated === true,
  };
}
```

- [ ] **Step 2.4: Run tests, watch them pass**

Run: `npx vitest run tests/http/usage.test.ts`
Expected: PASS — 5/5 tests green.

- [ ] **Step 2.5: Commit**

```bash
git add src/http/usage.ts tests/http/usage.test.ts
git commit -m "feat(usage): rolling 24h/7d/30d totals + malformed-line tolerance"
```

---

## Task 3: activeUsersToday + failRate7d

**Files:**
- Modify: `src/http/usage.ts`
- Modify: `tests/http/usage.test.ts`

- [ ] **Step 3.1: Add the test**

Append to `tests/http/usage.test.ts`:
```ts
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
```

At the top of `tests/http/usage.test.ts` (next to FIXED_NOW), add a small helper:
```ts
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 3.2: Run the new tests and watch them fail**

Run: `npx vitest run tests/http/usage.test.ts -t "activeUsersToday|failRate7d"`
Expected: FAIL (all three).

- [ ] **Step 3.3: Update `computeUsageStats` in `src/http/usage.ts`**

After the existing `today/last7d/last30d` loop, add:
```ts
  const todayUsers = new Set<string>();
  let fails7d = 0, total7d = 0;
  for (const r of rows) {
    if (r.ts > cutToday) todayUsers.add(r.user);
    if (r.ts > cut7d) {
      total7d++;
      if (!r.ok) fails7d++;
    }
  }
  const failRate7d = total7d === 0 ? 0 : Math.round((fails7d / total7d) * 1000) / 1000;
```

And in the returned object, replace the zero placeholders:
```ts
    activeUsersToday: todayUsers.size,
    failRate7d,
```

- [ ] **Step 3.4: Run tests, watch them pass**

Run: `npx vitest run tests/http/usage.test.ts`
Expected: PASS — 8/8 tests green.

- [ ] **Step 3.5: Commit**

```bash
git add src/http/usage.ts tests/http/usage.test.ts
git commit -m "feat(usage): activeUsersToday + failRate7d"
```

---

## Task 4: peakReqPerSecLastHour

**Files:**
- Modify: `src/http/usage.ts`
- Modify: `tests/http/usage.test.ts`

- [ ] **Step 4.1: Add the test**

Append to `tests/http/usage.test.ts`:
```ts
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
```

- [ ] **Step 4.2: Run new tests and watch them fail**

Run: `npx vitest run tests/http/usage.test.ts -t "peakReqPerSecLastHour"`
Expected: FAIL (all three).

- [ ] **Step 4.3: Implement in `src/http/usage.ts`**

Add a constant near `ONE_DAY`:
```ts
const ONE_HOUR = 60 * 60 * 1000;
```

After the existing aggregation loops, add:
```ts
  // Peak requests-per-second observed in the last hour. Bucket each row by
  // floor(ts / 1000); the max bucket count is the peak.
  const cutHour = now - ONE_HOUR;
  const buckets = new Map<number, number>();
  for (const r of rows) {
    if (r.ts <= cutHour) continue;
    const sec = Math.floor(r.ts / 1000);
    buckets.set(sec, (buckets.get(sec) ?? 0) + 1);
  }
  let peakReqPerSecLastHour = 0;
  for (const v of buckets.values()) {
    if (v > peakReqPerSecLastHour) peakReqPerSecLastHour = v;
  }
```

In the returned object, replace `peakReqPerSecLastHour: 0,` with `peakReqPerSecLastHour,`.

- [ ] **Step 4.4: Run tests, watch them pass**

Run: `npx vitest run tests/http/usage.test.ts`
Expected: PASS — 11/11 tests green.

- [ ] **Step 4.5: Commit**

```bash
git add src/http/usage.ts tests/http/usage.test.ts
git commit -m "feat(usage): peakReqPerSecLastHour via 1-second buckets"
```

---

## Task 5: 429-from-Simpro detection

**Files:**
- Modify: `src/http/usage.ts`
- Modify: `tests/http/usage.test.ts`

- [ ] **Step 5.1: Add the test**

Append to `tests/http/usage.test.ts`:
```ts
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
```

- [ ] **Step 5.2: Run new tests, watch them fail**

Run: `npx vitest run tests/http/usage.test.ts -t "rateLimitedTodayBySimpro"`
Expected: FAIL (both).

- [ ] **Step 5.3: Implement in `src/http/usage.ts`**

In the main loop that handles `cutToday` (the same one that increments `today`), extend it:
```ts
  let rateLimitedTodayBySimpro = 0;
  for (const r of rows) {
    if (r.ts > cutToday && !r.ok && r.errorMessage && /rate limit/i.test(r.errorMessage)) {
      rateLimitedTodayBySimpro++;
    }
  }
```

Place that block AFTER the existing `for (const r of rows)` that computed totals (don't try to merge — keep loops focused).

In the returned object, replace `rateLimitedTodayBySimpro: 0,` with `rateLimitedTodayBySimpro,`.

- [ ] **Step 5.4: Run tests, watch them pass**

Run: `npx vitest run tests/http/usage.test.ts`
Expected: PASS — 13/13 tests green.

- [ ] **Step 5.5: Commit**

```bash
git add src/http/usage.ts tests/http/usage.test.ts
git commit -m "feat(usage): count 429-from-Simpro events today"
```

---

## Task 6: Per-user table (counts, lastSeen, failRate7d, topTool)

**Files:**
- Modify: `src/http/usage.ts`
- Modify: `tests/http/usage.test.ts`

- [ ] **Step 6.1: Add the test**

Append to `tests/http/usage.test.ts`:
```ts
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
```

- [ ] **Step 6.2: Run new tests, watch them fail**

Run: `npx vitest run tests/http/usage.test.ts -t "perUser"`
Expected: FAIL (both).

- [ ] **Step 6.3: Implement perUser aggregation in `src/http/usage.ts`**

Replace the existing simple `perUser` mapping with a real aggregator. Insert before the `return` statement:
```ts
  // Build a working map keyed by user name; start with known users so they
  // appear even with zero activity, then layer in any users we see in lines.
  interface UserAgg {
    today: number;
    last7d: number;
    last30d: number;
    lastSeenMs: number | null;
    fails7d: number;
    total7d: number;
    toolCounts: Map<string, number>;
  }
  const agg = new Map<string, UserAgg>();
  for (const name of knownUsers) {
    agg.set(name, {
      today: 0, last7d: 0, last30d: 0,
      lastSeenMs: null, fails7d: 0, total7d: 0,
      toolCounts: new Map(),
    });
  }
  for (const r of rows) {
    let u = agg.get(r.user);
    if (!u) {
      u = { today: 0, last7d: 0, last30d: 0,
            lastSeenMs: null, fails7d: 0, total7d: 0,
            toolCounts: new Map() };
      agg.set(r.user, u);
    }
    if (r.ts > cutToday) u.today++;
    if (r.ts > cut7d) {
      u.last7d++;
      u.total7d++;
      if (!r.ok) u.fails7d++;
    }
    if (r.ts > cut30d) u.last30d++;
    if (u.lastSeenMs === null || r.ts > u.lastSeenMs) u.lastSeenMs = r.ts;
    u.toolCounts.set(r.tool, (u.toolCounts.get(r.tool) ?? 0) + 1);
  }
  const perUser: PerUserStats[] = [];
  for (const [name, u] of agg) {
    let topTool: string | null = null;
    let topCount = 0;
    for (const [tool, n] of u.toolCounts) {
      if (n > topCount) { topCount = n; topTool = tool; }
    }
    perUser.push({
      name,
      today: u.today,
      last7d: u.last7d,
      last30d: u.last30d,
      lastSeenMs: u.lastSeenMs,
      failRate7d: u.total7d === 0 ? 0 : Math.round((u.fails7d / u.total7d) * 1000) / 1000,
      topTool,
    });
  }
  // Sort by last30d desc, then by name asc (stable within ties).
  perUser.sort((a, b) => {
    if (b.last30d !== a.last30d) return b.last30d - a.last30d;
    return a.name.localeCompare(b.name);
  });
```

Then in the returned object, replace the simple `perUser` array with this `perUser` variable. Remove the earlier `const perUser = knownUsers.map(...)` placeholder.

- [ ] **Step 6.4: Run tests, watch them pass**

Run: `npx vitest run tests/http/usage.test.ts`
Expected: PASS — 15/15 tests green.

- [ ] **Step 6.5: Commit**

```bash
git add src/http/usage.ts tests/http/usage.test.ts
git commit -m "feat(usage): per-user table (counts, lastSeen, failRate, topTool)"
```

---

## Task 7: Time-pattern buckets (hourOfDay, dayOfMonth, dayOfWeek)

**Files:**
- Modify: `src/http/usage.ts`
- Modify: `tests/http/usage.test.ts`

- [ ] **Step 7.1: Add the test**

Append to `tests/http/usage.test.ts`:
```ts
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
    // 2026-05-22 is a Friday -> Mon=0..Fri=4 so bucket 4.
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
```

- [ ] **Step 7.2: Run new tests, watch them fail**

Run: `npx vitest run tests/http/usage.test.ts -t "time-pattern"`
Expected: FAIL (all four).

- [ ] **Step 7.3: Implement in `src/http/usage.ts`**

Add a constant:
```ts
const NINETY_DAYS = 90 * ONE_DAY;
```

After the per-user aggregation, add:
```ts
  const hourOfDay = Array(24).fill(0) as number[];
  const dayOfMonth = Array(31).fill(0) as number[];
  const dayOfWeek = Array(7).fill(0) as number[];
  const cut90d = now - NINETY_DAYS;
  for (const r of rows) {
    if (r.ts > cut30d) {
      const d = new Date(r.ts);
      hourOfDay[d.getHours()]++;
      // Convert JS Sun..Sat (0..6) to Mon..Sun (0..6).
      dayOfWeek[(d.getDay() + 6) % 7]++;
    }
    if (r.ts > cut90d) {
      const d = new Date(r.ts);
      dayOfMonth[d.getDate() - 1]++;
    }
  }
```

In the returned object, replace the three placeholder arrays with these variables.

- [ ] **Step 7.4: Run tests, watch them pass**

Run: `npx vitest run tests/http/usage.test.ts`
Expected: PASS — 19/19 tests green.

- [ ] **Step 7.5: Commit**

```bash
git add src/http/usage.ts tests/http/usage.test.ts
git commit -m "feat(usage): time-pattern buckets (hour, day-of-month, day-of-week)"
```

---

## Task 8: SVG bar-chart helper

**Files:**
- Modify: `src/http/admin-templates.ts`
- Create: `tests/http/usageTemplate.test.ts`

- [ ] **Step 8.1: Add the test file**

`tests/http/usageTemplate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { renderBarChart } from "../../src/http/admin-templates.js";

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
```

- [ ] **Step 8.2: Run new tests, watch them fail**

Run: `npx vitest run tests/http/usageTemplate.test.ts`
Expected: FAIL — `renderBarChart` not exported.

- [ ] **Step 8.3: Implement in `src/http/admin-templates.ts`**

Add (anywhere in the file, but near other helpers):
```ts
/**
 * Render a small inline SVG bar chart. Pure function: input data + labels,
 * output HTML string. Used by the usage dashboard for the time-pattern
 * charts. Bars are 16 px wide with 2 px gaps; height scales so the tallest
 * bar reaches `maxHeight`. Empty / all-zero input renders as flat bars.
 */
export function renderBarChart(
  values: number[],
  opts: { labelEvery: number; axisLabels: string[]; maxHeight?: number },
): string {
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const barW = 16;
  const gap = 2;
  const maxH = opts.maxHeight ?? 50;
  const width = values.length * (barW + gap) - gap;
  const totalH = maxH + 18; // room for the x-axis labels under the bars
  const bars = values.map((v, i) => {
    const h = max === 0 ? 1 : Math.max(1, Math.round((v / max) * maxH));
    const x = i * (barW + gap);
    const y = maxH - h;
    return `<g><rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="#0f4c75"><title>${v}</title></rect></g>`;
  }).join("");
  const labels = values.map((_, i) => {
    if (opts.labelEvery <= 0 || i % opts.labelEvery !== 0) return "";
    const x = i * (barW + gap) + barW / 2;
    const label = opts.axisLabels[i] ?? "";
    return `<text x="${x}" y="${maxH + 14}" text-anchor="middle" font-size="10" fill="#888">${label}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalH}" viewBox="0 0 ${width} ${totalH}" role="img">${bars}${labels}</svg>`;
}
```

- [ ] **Step 8.4: Run tests, watch them pass**

Run: `npx vitest run tests/http/usageTemplate.test.ts`
Expected: PASS — 4/4 tests green.

- [ ] **Step 8.5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8.6: Commit**

```bash
git add src/http/admin-templates.ts tests/http/usageTemplate.test.ts
git commit -m "feat(admin): SVG bar-chart helper for usage dashboard"
```

---

## Task 9: renderUsageView template

**Files:**
- Modify: `src/http/admin-templates.ts`
- Modify: `tests/http/usageTemplate.test.ts`

- [ ] **Step 9.1: Add the test**

Append to `tests/http/usageTemplate.test.ts`:
```ts
import { renderUsageView } from "../../src/http/admin-templates.js";
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
      { name: "Tayfun", today: 4, last7d: 30, last30d: 120, lastSeenMs: Date.now(),
        failRate7d: 0.02, topTool: "simpro_search_jobs" },
      { name: "Sarah",  today: 0, last7d: 5,  last30d: 18,  lastSeenMs: null,
        failRate7d: 0, topTool: null },
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
});
```

- [ ] **Step 9.2: Run new tests, watch them fail**

Run: `npx vitest run tests/http/usageTemplate.test.ts -t "renderUsageView"`
Expected: FAIL — `renderUsageView` not exported.

- [ ] **Step 9.3: Implement `renderUsageView` in `src/http/admin-templates.ts`**

Add at the bottom of the file:
```ts
import type { UsageStats } from "./usage.js";

function fmtRelativeFromMs(ms: number | null, now: number): string {
  if (ms === null) return "never";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function tile(label: string, value: string, sub?: string): string {
  return `<div class="kpi">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value">${esc(value)}</div>
    ${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}
  </div>`;
}

const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => String(i));
const DOM_LABELS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function renderUsageView(adminName: string, stats: UsageStats): string {
  const now = Date.now();
  const failPct = (stats.failRate7d * 100).toFixed(1) + "%";
  const localRl = stats.localRateLimitHitsToday < 0
    ? "—" : String(stats.localRateLimitHitsToday);
  const peakSub = stats.peakReqPerSecLastHour >= 7 ? "near 10/s ceiling"
                  : stats.peakReqPerSecLastHour >= 3 ? "moderate"
                  : "plenty of headroom";

  const trunc = stats.truncated
    ? `<div class="trunc">Older entries truncated to keep the page snappy. Counts for the 30/90-day buckets may slightly under-report.</div>`
    : "";

  const tiles = [
    tile("Today",              String(stats.totals.today)),
    tile("Last 7 days",        String(stats.totals.last7d)),
    tile("Last 30 days",       String(stats.totals.last30d)),
    tile("Active users today", String(stats.activeUsersToday)),
    tile("Fail rate (7d)",     failPct),
    tile("Peak req/sec (1h)",  String(stats.peakReqPerSecLastHour), peakSub),
    tile("429s from Simpro",   String(stats.rateLimitedTodayBySimpro), "today"),
    tile("Local rate-limit hits", localRl, "today"),
  ].join("");

  const rows = stats.perUser.length === 0
    ? `<tr><td colspan="7" class="empty">No users enrolled yet.</td></tr>`
    : stats.perUser.map((u) => {
      const fp = u.total7dPresent() ? (u.failRate7d * 100).toFixed(1) + "%" : "—";
      // (above helper not used — see actual line below)
      const fpStr = u.last7d === 0 ? "—" : (u.failRate7d * 100).toFixed(1) + "%";
      return `<tr>
        <td><b>${esc(u.name)}</b></td>
        <td class="num">${u.today}</td>
        <td class="num">${u.last7d}</td>
        <td class="num">${u.last30d}</td>
        <td>${esc(fmtRelativeFromMs(u.lastSeenMs, now))}</td>
        <td class="num">${fpStr}</td>
        <td>${u.topTool ? esc(u.topTool) : "—"}</td>
      </tr>`;
    }).join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Usage — Goldman Simpro admin</title>
<style>${STYLE}
  .kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));
          gap:10px; margin-bottom:16px; }
  .kpi { background:#fff; padding:14px; border-radius:6px;
         box-shadow:0 1px 3px rgba(0,0,0,0.08); }
  .kpi-label { font-size:11px; color:#666; text-transform:uppercase;
               letter-spacing:0.05em; }
  .kpi-value { font-size:24px; font-weight:700; color:#0f4c75; margin-top:2px; }
  .kpi-sub   { font-size:11px; color:#888; margin-top:2px; }
  .charts { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));
            gap:16px; margin-top:16px; }
  .chart { background:#fff; padding:14px; border-radius:6px;
           box-shadow:0 1px 3px rgba(0,0,0,0.08); }
  .chart h3 { font-size:13px; color:#0f4c75; margin:0 0 8px; }
  .chart svg { display:block; max-width:100%; height:auto; }
  td.num { font-variant-numeric: tabular-nums; text-align:right; }
  .trunc { background:#fff3cd; color:#8a6d3b; padding:8px 12px;
           border-radius:4px; margin-bottom:12px; font-size:13px; }
</style></head><body>
<h1>Usage · ${esc(adminName)}</h1>
${NAV}
${trunc}
<div class="kpis">${tiles}</div>

<h2 style="font-size:16px;color:#0f4c75;margin:16px 0 8px;">Per user (last 30 days)</h2>
<table>
  <thead><tr>
    <th>User</th><th>Today</th><th>7d</th><th>30d</th>
    <th>Last seen</th><th>Fail rate</th><th>Top tool</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>

<div class="charts">
  <div class="chart"><h3>Hour of day (last 30 days)</h3>
    ${renderBarChart(stats.hourOfDay, { labelEvery: 4, axisLabels: HOUR_LABELS })}
  </div>
  <div class="chart"><h3>Day of month (last 90 days)</h3>
    ${renderBarChart(stats.dayOfMonth, { labelEvery: 5, axisLabels: DOM_LABELS })}
  </div>
  <div class="chart"><h3>Day of week (last 30 days)</h3>
    ${renderBarChart(stats.dayOfWeek, { labelEvery: 1, axisLabels: DOW_LABELS })}
  </div>
</div>
</body></html>`;
}
```

NOTE: in the `rows` mapping above I accidentally left a stale line referring to `u.total7dPresent()` — DELETE that line so only the `fpStr` definition remains. The corrected map body is:
```ts
    stats.perUser.map((u) => {
      const fpStr = u.last7d === 0 ? "—" : (u.failRate7d * 100).toFixed(1) + "%";
      return `<tr>
        <td><b>${esc(u.name)}</b></td>
        <td class="num">${u.today}</td>
        <td class="num">${u.last7d}</td>
        <td class="num">${u.last30d}</td>
        <td>${esc(fmtRelativeFromMs(u.lastSeenMs, now))}</td>
        <td class="num">${fpStr}</td>
        <td>${u.topTool ? esc(u.topTool) : "—"}</td>
      </tr>`;
    }).join("");
```

- [ ] **Step 9.4: Run tests, watch them pass**

Run: `npx vitest run tests/http/usageTemplate.test.ts`
Expected: PASS — 8/8 tests green (4 from Task 8 + 4 new).

- [ ] **Step 9.5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 9.6: Commit**

```bash
git add src/http/admin-templates.ts tests/http/usageTemplate.test.ts
git commit -m "feat(admin): renderUsageView template with KPIs, per-user table, 3 charts"
```

---

## Task 10: Add "Usage" link to the admin NAV

**Files:**
- Modify: `src/http/admin-templates.ts`

- [ ] **Step 10.1: Locate the NAV constant and update it**

Find this in `src/http/admin-templates.ts`:
```ts
const NAV = `<div class="nav">
  <a href="/admin">Users</a>
  <a href="/admin/audit">Audit log</a>
  <a href="/admin/users/new">Create user manually</a>
```

Insert a Usage link between Audit log and Create user manually:
```ts
const NAV = `<div class="nav">
  <a href="/admin">Users</a>
  <a href="/admin/audit">Audit log</a>
  <a href="/admin/usage">Usage</a>
  <a href="/admin/users/new">Create user manually</a>
```

- [ ] **Step 10.2: Run all tests to ensure nothing broke**

Run: `npm test`
Expected: PASS — all tests green (including the unchanged admin tests).

- [ ] **Step 10.3: Commit**

```bash
git add src/http/admin-templates.ts
git commit -m "feat(admin): add 'Usage' link to nav"
```

---

## Task 11: usageRoute.ts — wire reader + tokens + render

**Files:**
- Create: `src/http/usageRoute.ts`
- Modify: `src/http/admin.ts`
- Create: `tests/http/usageRoute.test.ts`

- [ ] **Step 11.1: Write the supertest integration test FIRST**

`tests/http/usageRoute.test.ts`:
```ts
// tests/http/usageRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import request from "supertest";
import { attachAdminRoutes } from "../../src/http/admin.js";
import type { Config } from "../../src/config.js";

let tokensFile: string;
let auditFile: string;

beforeEach(() => {
  const suffix = `${Date.now()}-${Math.random()}`;
  tokensFile = path.join(os.tmpdir(), `usage-tokens-${suffix}.json`);
  auditFile = path.join(os.tmpdir(), `usage-audit-${suffix}.log`);
});

afterEach(() => {
  for (const f of [tokensFile, auditFile]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const config = {
    SIMPRO_TOKENS_FILE: tokensFile,
    SIMPRO_BASE_URL: "https://test.simprosuite.com",
    SIMPRO_AUDIT_FILE: auditFile,
  } as unknown as Config;
  const router = express.Router();
  attachAdminRoutes(router, config);
  app.use(router);
  return app;
}

function writeAdminToken() {
  fs.writeFileSync(tokensFile, JSON.stringify({
    tokens: {
      "smcp_admin": {
        name: "Tayfun", simproApiKey: "k1admin-12345",
        companyAccess: ["plumbing"], isAdmin: true,
      },
    },
  }));
}

describe("GET /admin/usage", () => {
  it("returns 401 when no auth is given", async () => {
    fs.writeFileSync(tokensFile, JSON.stringify({ tokens: {} }));
    const res = await request(buildApp()).get("/admin/usage");
    expect(res.status).toBe(401);
  });

  it("returns 403 when authed user is not admin", async () => {
    fs.writeFileSync(tokensFile, JSON.stringify({
      tokens: {
        "smcp_user": {
          name: "User", simproApiKey: "k1user-12345",
          companyAccess: ["plumbing"], isAdmin: false,
        },
      },
    }));
    const res = await request(buildApp())
      .get("/admin/usage")
      .set("Authorization", "Bearer smcp_user");
    expect(res.status).toBe(403);
  });

  it("returns 200 HTML with the admin's name and KPI labels for an admin", async () => {
    writeAdminToken();
    // Seed one audit line so the page renders some data.
    fs.writeFileSync(auditFile, JSON.stringify({
      ts: new Date().toISOString(),
      user: "Tayfun", company: "plumbing", tool: "simpro_search_jobs",
      ok: true, durationMs: 42,
    }) + "\n");
    const res = await request(buildApp())
      .get("/admin/usage")
      .set("Authorization", "Bearer smcp_admin");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("Tayfun");
    expect(res.text).toContain("Today");
    expect(res.text).toContain("Hour of day");
  });
});
```

- [ ] **Step 11.2: Run the new tests, watch them fail**

Run: `npx vitest run tests/http/usageRoute.test.ts`
Expected: FAIL — 404 on `/admin/usage` (route not yet attached).

- [ ] **Step 11.3: Create `src/http/usageRoute.ts`**

```ts
// src/http/usageRoute.ts
// GET /admin/usage — loads the audit history (live file + monthly archives)
// over the last 90 days, loads the enrolled user list, runs computeUsageStats,
// and renders the dashboard page. This file is the only place that joins
// I/O to the pure aggregator in usage.ts.

import type { Request, Response } from "express";
import type { Config } from "../config.js";
import { loadTokens } from "./tokens.js";
import { readRange } from "./auditReader.js";
import { computeUsageStats } from "./usage.js";
import { ADMIN_HEADERS, renderUsageView } from "./admin-templates.js";

/** Days of audit history to load. Matches the widest chart window. */
const USAGE_WINDOW_DAYS = 90;
/** Hard cap on lines loaded into memory. Matches the spec's safety bound. */
const USAGE_LINE_CAP = 50_000;

export function handleUsageGet(config: Config) {
  return (_req: Request, res: Response) => {
    const now = Date.now();
    const from = new Date(now - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const to = new Date(now);
    const range = readRange(config.SIMPRO_AUDIT_FILE, from, to, USAGE_LINE_CAP);
    const store = loadTokens(config.SIMPRO_TOKENS_FILE);
    const knownUsers = Object.values(store.tokens).map((r) => r.name);
    const stats = computeUsageStats(range.lines, knownUsers, {
      now,
      truncated: range.truncated,
    });
    const adminName = (res.locals as { admin: { name: string } }).admin.name;
    for (const [k, v] of Object.entries(ADMIN_HEADERS)) res.set(k, v);
    res.type("text/html").send(renderUsageView(adminName, stats));
  };
}
```

- [ ] **Step 11.4: Mount the route in `src/http/admin.ts`**

Add an import near the top (with the other route-helper imports):
```ts
import { handleUsageGet } from "./usageRoute.js";
```

Inside `attachAdminRoutes`, after the existing `GET /admin/audit` route, add:
```ts
  // GET /admin/usage — read-only analytics dashboard.
  router.get("/admin/usage", admin, handleUsageGet(config));
```

- [ ] **Step 11.5: Run the integration tests**

Run: `npx vitest run tests/http/usageRoute.test.ts`
Expected: PASS — 3/3 tests green.

- [ ] **Step 11.6: Run the FULL test suite to confirm nothing else broke**

Run: `npm test`
Expected: PASS — 79 existing + new tests, all green.

- [ ] **Step 11.7: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 11.8: Commit**

```bash
git add src/http/usageRoute.ts src/http/admin.ts tests/http/usageRoute.test.ts
git commit -m "feat(admin): GET /admin/usage route (wires reader + tokens + render)"
```

---

## Task 12: Push + deploy to Ubuntu box

**Files:** none (deploy only)

- [ ] **Step 12.1: Final pre-flight — full test + build clean**

Run: `npm run typecheck && npm run build && npm test`
Expected: all clean, all tests pass.

- [ ] **Step 12.2: Push to origin**

```bash
git push origin feat/http-transport
```

Expected: push succeeds.

- [ ] **Step 12.3: Pull + rebuild + restart on the Ubuntu box**

```bash
ssh goldman-ubuntu 'bash -s' <<'EOF'
PW='Gold@1234'; run() { echo "$PW" | sudo -S -p '' "$@"; }
cd /opt/simpro-mcp
run -u simpro-mcp git checkout -- package-lock.json
run -u simpro-mcp git pull --ff-only
run -u simpro-mcp npm ci 2>&1 | tail -2
run -u simpro-mcp npm run build 2>&1 | tail -2
run -u simpro-mcp npm prune --omit=dev 2>&1 | tail -1
run systemctl restart simpro-mcp
sleep 2
run systemctl is-active simpro-mcp
curl -s -o /dev/null -w 'local healthz:  %{http_code}\n' http://127.0.0.1:3001/healthz
curl -s -o /dev/null -w 'usage page:     %{http_code}\n' \
  -H 'Authorization: Bearer smcp_RVbocdemffvtaM1P2jgbCQYyuWhYtBCdG4m5HChGX7k' \
  http://127.0.0.1:3001/admin/usage
EOF
```

Expected: `active`, both 200s.

- [ ] **Step 12.4: Browser smoke**

Open https://goldman-ubuntu.tail6b5a4b.ts.net/admin/usage and confirm:
- The page loads with all 8 KPI tiles populated.
- Per-user table shows at least your row (Tayfun) with real counts.
- Three SVG charts visible (Hour of day, Day of month, Day of week).
- "Usage" link appears in the nav alongside Users / Audit log / Create user manually.

If any of the above is missing or broken, file a follow-up — do NOT roll back automatically.

---

## Self-Review (run mentally before handing off)

**1. Spec coverage:**

| Spec section | Implemented in |
|---|---|
| KPI tiles (today/7d/30d, active, fail, peak, 429, local-RL) | Tasks 2–6 (aggregator) + Task 9 (template) |
| Per-user table | Task 6 (aggregator) + Task 9 (template) |
| Hour-of-day / day-of-month / day-of-week charts | Task 7 (aggregator) + Tasks 8–9 (renderBarChart + template) |
| Pure `usage.ts` + thin route | Tasks 1–7 + Task 11 |
| 50k cap via existing `auditReader.readRange` | Task 11 (`USAGE_LINE_CAP`) |
| "Today" = rolling 24h | Tasks 2 + 3 use `cutToday = now - ONE_DAY` |
| 429 detection via `errorMessage` match | Task 5 |
| `localRateLimitHitsToday` ships as `—` (sentinel `-1`) | Task 1 + Task 9 |
| Admin-only via `requireAdmin` | Task 11 (route mounts with `admin` middleware) |
| Nav link | Task 10 |
| Unit + integration tests | Tasks 1–9 (unit) + Task 11 (integration) |
| Truncated banner | Task 9 (test) + Task 11 (passes `truncated` from `readRange`) |
| Empty-state friendly | Task 1 (empty input test) + Task 9 (empty perUser test) |
| Sydney-local hour-of-day | Task 7 (uses `new Date().getHours()`) |

**2. Placeholder scan:** none — every step shows the actual code to write or the actual command to run.

**3. Type consistency:** `UsageStats` defined in Task 1, used unchanged through Tasks 2–7, imported by Tasks 9 + 11. `PerUserStats.lastSeenMs` is `number | null` everywhere; `localRateLimitHitsToday` is `number` (sentinel `-1`) everywhere. `renderBarChart(values, opts)` signature matches between Task 8 implementation and Task 9 callers.

Plan is complete and self-consistent.
