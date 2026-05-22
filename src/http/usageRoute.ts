// src/http/usageRoute.ts
// GET /admin/usage — loads the audit history (live file + monthly archives)
// over the last 90 days, loads the enrolled user list, runs computeUsageStats,
// and renders the dashboard page. This file is the only place that joins
// I/O to the pure aggregator in usage.ts.

import type { Request, Response } from "express";
import type { Config } from "../config.js";
import { loadTokens } from "./tokens.js";
import { readRange } from "./auditReader.js";
import { computeUsageStats, type ResolvedRange } from "./usage.js";
import { ADMIN_HEADERS, renderUsageView } from "./admin-templates.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
const USAGE_WINDOW_DAYS = 90;
const USAGE_LINE_CAP = 50_000;

// Re-export so existing imports `import { ResolvedRange } from "./usageRoute.js"` keep working.
export type { ResolvedRange } from "./usage.js";

/**
 * Parse `?range=today|7d|30d|90d|custom` (with optional `&from=YYYY-MM-DD&to=YYYY-MM-DD`
 * for custom). Falls back to "30d" on any malformed input.
 */
export function parseRange(query: Record<string, unknown>): ResolvedRange {
  const r = typeof query.range === "string" ? query.range : "";
  if (r === "today") return { rangeKey: "today", rangeMs: ONE_DAY };
  if (r === "7d")    return { rangeKey: "7d",    rangeMs: 7 * ONE_DAY };
  if (r === "90d")   return { rangeKey: "90d",   rangeMs: 90 * ONE_DAY };
  if (r === "custom") {
    const from = typeof query.from === "string" ? query.from : "";
    const to   = typeof query.to   === "string" ? query.to   : "";
    const m = /^(\d{4})-(\d{2})-(\d{2})$/;
    if (m.test(from) && m.test(to)) {
      const fromMs = Date.parse(from + "T00:00:00Z");
      const toMs   = Date.parse(to   + "T23:59:59Z");
      if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
        return { rangeKey: "custom", rangeMs: toMs - fromMs, fromIso: from, toIso: to };
      }
    }
    // Custom selected but no valid from/to yet — keep rangeKey as "custom"
    // so the picker shows the date inputs. Charts/table use a 30d window
    // until the user fills in the dates.
    return { rangeKey: "custom", rangeMs: 30 * ONE_DAY, fromIso: from || undefined, toIso: to || undefined };
  }
  return { rangeKey: "30d", rangeMs: 30 * ONE_DAY };
}

export function handleUsageGet(config: Config) {
  return (req: Request, res: Response) => {
    const now = Date.now();
    const range = parseRange(req.query as Record<string, unknown>);
    const from = new Date(now - USAGE_WINDOW_DAYS * ONE_DAY);
    const to = new Date(now);
    const rangeResult = readRange(config.SIMPRO_AUDIT_FILE, from, to, USAGE_LINE_CAP);
    const store = loadTokens(config.SIMPRO_TOKENS_FILE);
    const knownUsers = Object.values(store.tokens).map((r) => r.name);
    const stats = computeUsageStats(rangeResult.lines, knownUsers, {
      now,
      truncated: rangeResult.truncated,
      rangeMs: range.rangeMs,
    });
    const adminName = (res.locals as { admin: { name: string } }).admin.name;
    for (const [k, v] of Object.entries(ADMIN_HEADERS)) res.set(k, v);
    res.type("text/html").send(renderUsageView(adminName, stats, now, range));
  };
}
