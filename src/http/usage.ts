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
const ONE_HOUR = 60 * 60 * 1000;

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

  let rateLimitedTodayBySimpro = 0;
  for (const r of rows) {
    if (r.ts > cutToday && !r.ok && r.errorMessage && /rate limit/i.test(r.errorMessage)) {
      rateLimitedTodayBySimpro++;
    }
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
    activeUsersToday: todayUsers.size,
    failRate7d,
    peakReqPerSecLastHour,
    rateLimitedTodayBySimpro,
    localRateLimitHitsToday: -1,
    perUser,
    hourOfDay: Array(24).fill(0),
    dayOfMonth: Array(31).fill(0),
    dayOfWeek: Array(7).fill(0),
    truncated: opts.truncated === true,
  };
}
