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
    res.type("text/html").send(renderUsageView(adminName, stats, now));
  };
}
