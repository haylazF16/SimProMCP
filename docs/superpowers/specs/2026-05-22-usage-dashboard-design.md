# Usage Dashboard — design

> Status: design approved (2026-05-22). Next: implementation plan.

## Why

The admin dashboard today shows two things: the user list (`/admin`) and the
activity feed (`/admin/audit`). The activity feed answers "what happened
last?", but it can't answer the questions an operator actually has after a
few weeks of real use:

- **Who is using this, and how much?** (per-user accountability)
- **Is adoption growing?** (volume over time)
- **When in the day or month do people use it?** (work-pattern insight, useful
  for planning training, batch jobs, or just understanding the team's rhythm)
- **Are we anywhere near Simpro's 10 req/sec API ceiling?** (operational
  awareness — no warnings or enforcement, just visibility)
- **Are calls succeeding?** (failure rate as a health proxy)

A purpose-built `/admin/usage` page answers these at a glance, derived
entirely from data we already have (audit log + tokens.json). No new
instrumentation, no schema changes, no enforced quotas.

## Scope

- **In:** A single new page at `/admin/usage`, admin-only (same auth as the
  rest of `/admin/*`). KPI tiles + per-user table + three time-pattern bar
  charts (hour-of-day, day-of-month, day-of-week).
- **Out:** Per-user drill-down pages (deferred). Per-tool deep-dives
  (deferred). Enforced quotas / "approaching limit" warning messages
  (explicitly declined by the user — informational dashboard only). LLM
  token usage (invisible to the MCP server). Push alerts (none).

## Data sources

Every metric is computed at request time from:

1. **`audit.log`** (current month) + **`backups/audit/audit-YYYY-MM.log.gz`**
   archives — the same files `auditReader.ts` already knows how to read.
   One JSON line per tool call, fields:
   `{ts, user, company, tool, ok, durationMs, errorMessage?, details?}`.
2. **`tokens.json`** — list of enrolled users (for displaying users with
   zero calls in the window).

No new persisted state. No new write paths. The page is purely a read-only
projection over data that already exists.

### How "429 from Simpro" is detected

The audit log's `errorMessage` field is the user-facing message from
`SimproApiError`, which for 429 reads `"Rate limited by Simpro — wait a
moment and try again."` (see `src/simpro/errors.ts`). We detect 429s by
matching `/rate limit/i` in `errorMessage` on rows where `ok=false`. This
is sufficient for the dashboard — false positives would require an error
that contains "rate limit" but isn't a 429, which is unlikely in our error
shape. If false positives become a problem, we can extend
`AuditEntry.errorMessage` to include the upstream status code.

### How "peak req/sec last hour" is computed

We're counting **tool calls**, not raw outgoing Simpro HTTP requests. One
tool call may make 1+ Simpro requests internally (e.g. a search that
auto-resolves a customer name makes 2). This is a documented
approximation; in practice it tracks closely enough to the real outgoing
rate to be useful as an "are we close to 10/sec" indicator, and it
deliberately under-estimates so when the tile shows red we're definitely
in trouble (not the other way).

Computation: bucket the last 60 minutes of audit entries into one-second
buckets, take the max. Colors: green <3/sec, yellow 3–7, red 7+.

## Page layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  Activity log · Tayfun                                              │
│  [Users] [Audit log] [Usage] [Create user manually]   [Logout]      │
│                                                                     │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌─────────┐ ┌────────┐ ┌─────┐ ┌──────┐│
│  │Today │ │ 7d   │ │ 30d  │ │ Active  │ │ Fail   │ │Peak │ │ 429s ││
│  │ 47   │ │ 312  │ │1,204 │ │ today 3 │ │ 1.2%   │ │1/s  │ │  0   ││
│  └──────┘ └──────┘ └──────┘ └─────────┘ └────────┘ └─────┘ └──────┘│
│                                                                     │
│  Per user (last 30 days)                                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Name      Today  7d   30d   Last seen   Fail%   Top tool     │  │
│  │ Tayfun     47   312  1204  2 min ago    1.2%   search_jobs   │  │
│  │ Sarah       0    18    42  3 days ago   0%     get_invoice   │  │
│  │ Jamie       0     0     0  never        —      —             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  When (last 30 days)                                                │
│  Hour of day:    ▁▁▁▁▁▁▁▂▄▆█▇▅▄▆▇▅▃▂▁▁▁▁▁                          │
│                  0  4  8  12 16 20                                  │
│  Day of month:   ▃▂▁▂▃▄▅▆▅▄▃▂▂▁▂▃▄▅▆▇▆▅▄▃▂▂▃▅▇█                    │
│                  1  5  10 15 20 25 30                               │
│  Day of week:    █▇▆▅▆▃▁                                            │
│                  Mon Tue Wed Thu Fri Sat Sun                        │
└─────────────────────────────────────────────────────────────────────┘
```

The sparkbars above are illustrative — the real renders are inline SVG bar
charts, ~200 px wide × ~40 px tall, with X-axis labels under each bar
group.

## Architecture & components

```
src/http/
├── usage.ts          (new) — pure functions that aggregate audit lines
│                              into UsageStats; no I/O, fully testable.
├── usageRoute.ts     (new) — Express route handler for GET /admin/usage:
│                              loads audit lines + tokens.json, calls
│                              usage.ts, passes result to admin-templates.
├── admin.ts          (mod) — attach the new route + add a nav link.
└── admin-templates.ts(mod) — new renderUsageView(adminName, stats) that
                              produces the HTML page, including SVG charts.
```

The split keeps each piece small and testable:

- **`usage.ts`** is pure (input: audit lines + tokens; output: stats
  object). Easy unit tests.
- **`usageRoute.ts`** is the thin wrapper that does the file I/O and
  hands off to the renderer.
- **`admin-templates.ts`** gains one new exported function;
  no existing templates change.

### `UsageStats` shape (output of `usage.ts`)

```ts
interface UsageStats {
  totals: { today: number; last7d: number; last30d: number };
  activeUsersToday: number;
  failRate7d: number;          // 0..1
  peakReqPerSecLastHour: number;
  rateLimitedTodayBySimpro: number; // 429s from upstream
  localRateLimitHitsToday: number;  // from log scan or sentinel; see note
  perUser: Array<{
    name: string;
    today: number;
    last7d: number;
    last30d: number;
    lastSeenMs: number | null;
    failRate7d: number;
    topTool: string | null;
  }>;
  hourOfDay: number[];      // length 24, counts in last 30d
  dayOfMonth: number[];     // length 31, counts in last 90d
  dayOfWeek: number[];      // length 7 (Mon..Sun), counts in last 30d
}
```

> Note on **localRateLimitHitsToday**: the in-memory rate limiter's events
> are currently logged to stderr (`[rate] SOFT user=...`, `[rate] HARD ...`)
> but not into `audit.log`. For v1 we tally these by scanning today's
> portion of `journalctl` output — or simpler, set this tile to a constant
> `0` with a tooltip "in-memory state; if you want this counted, raise
> SIMPRO_RECORD_RATE_LIMITER_EVENTS in a later patch." Decision: ship v1
> with the tile showing `—` and a tooltip explaining; raising the
> instrumentation is a separate follow-up so this dashboard isn't
> blocked by a logging refactor.

## Data loading strategy

The widest window we need is **last 90 days** (the day-of-month chart);
everything else is a subset. So one load of 90 days is enough to compute
every tile.

### Time-window definitions

To avoid ambiguity:

- **"Today"** = the **rolling last 24 hours** (`now - 24h .. now`), NOT
  the local-midnight-to-now window. This keeps the tile meaningful no
  matter when you check it — a 9 pm check shows the last full work day,
  not just "since midnight".
- **"Last 7d" / "Last 30d" / "Last 90d"** = the corresponding rolling
  windows.
- **Hour-of-day chart** uses each row's local hour
  (`new Date(ts).getHours()` — Node uses the box's TZ, which is
  Australia/Sydney). Documented so tests can pin behaviour.

### Loading

1. Compute `from = now - 90d`, `to = now`.
2. Call `auditReader.readRange(audit.log, from, to, 50_000)`. This
   already handles the live file + relevant monthly archives.
3. The 50k cap is `auditReader`'s existing safety bound. If hit, the
   *oldest* lines in the range are dropped (newest kept), so the
   90-day chart degrades silently while the 24 h / 7 d tiles stay
   accurate. `auditReader` already returns a `truncated` flag we can
   surface in a footer note when set.

Performance at expected scale: 10 users × 200 calls/day × 90 days
= 180,000 lines worst-case; the 50k cap puts a hard ceiling on memory.
The page is hit a few times a day at most, so re-reading on every
request is fine for v1. A 60-second in-memory cache keyed by minute is
a deferred optimization, NOT in v1 scope.

## SVG bar-chart rendering

A single small helper `renderBarChart(values: number[], opts)` in
`admin-templates.ts`:

- Accepts a flat array of counts and labels for the X axis.
- Emits a `<svg>` with one `<rect>` per bar, height scaled to the
  array's max value. Bars in the brand blue (`#0f4c75`), labels in `#888`
  below.
- Adds a `title` element on each bar with the raw count, so hovering
  shows the exact number.
- Width: 100 % of parent; height: 60 px. Bar gap: 2 px. Numeric labels
  below every 5th bar to avoid crowding.

No JS library; no client-side scripting. Pure server-rendered SVG.

## Auth & headers

Identical to other `/admin/*` pages: gated by the existing `requireAdmin`
middleware (cookie OR Bearer header), CSP/`X-Frame-Options` headers via
`ADMIN_HEADERS`. No new auth surface.

## Error handling

- Missing `audit.log` (brand-new install) → render the page with all
  zeros and a friendly "No activity recorded yet — usage will populate
  here once tools start being called." banner above the tiles.
- Missing/corrupt monthly archive → log a warning, skip that archive,
  continue. The page degrades but doesn't error.
- `tokens.json` unreadable → show 401/500 via existing admin error path;
  same behaviour as `/admin`.

## Testing

A new `tests/http/usage.test.ts` with cases for the pure `usage.ts`:

1. Empty input → all zeros / empty arrays / lastSeen=null.
2. Single user with calls spread across 3 days → totals correct, lastSeen
   matches newest timestamp, day-of-week bucket non-zero on the right
   slot.
3. Mixed success/failure → failRate7d computed correctly to 3 d.p.
4. Multiple users → perUser sorted by `last30d` descending; users with 0
   calls present at the bottom.
5. Hour-of-day fixture spanning midnight in Australia/Sydney → correct
   bucket assignment using local time (the existing
   `new Date(iso).getHours()` in Node, which respects the box's TZ).
   Use a fixture with timestamps in known Sydney hours.
6. 429-detection: a failed row with `errorMessage` containing "Rate
   limited by Simpro" increments `rateLimitedTodayBySimpro`; a non-429
   failure does not.
7. peakReqPerSecLastHour: 8 calls bucketed into the same second → 8;
   spread across 60 seconds → 1; empty last hour → 0.
8. Window cutoffs: a row 24 h + 1 second old does NOT count in "today";
   a row 23 h 59 m old does. Same for 7d and 30d.

A separate `tests/http/usageRoute.test.ts` (supertest):

1. Unauthenticated → 401 (and redirect for HTML).
2. Authenticated non-admin → 403.
3. Authenticated admin → 200, HTML contains the user's name and at least
   one of the per-user table headers (smoke test only — we don't snapshot
   the whole HTML).

Target: 8–10 new unit tests + 3 integration tests. Existing 79 stay green.

## Roll-out

- Code lands on `feat/http-transport`, normal deploy flow
  (build → restart). No migration. No new env vars.
- After deploy: visit `/admin/usage`, confirm tiles populate, confirm at
  least one bar in each chart matches what you remember from recent
  activity. No user-facing changes other than the new nav link.

## Future (deferred, not in this scope)

- Per-user drill-down (`/admin/usage/:user`)
- Per-tool drill-down (`/admin/usage/tools`)
- Cache layer (60-second in-memory) if the page load gets slow at 100k+
  audit lines
- Persisting local-rate-limiter events into the audit stream so the
  "local rate-limit hits today" tile shows a real number
- Optional CSV export of the per-user table for end-of-month reporting
