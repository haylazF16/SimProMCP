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
