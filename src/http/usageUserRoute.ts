// src/http/usageUserRoute.ts
// GET /admin/usage/:userName — per-user drill-down page.

import type { Request, Response } from "express";
import type { Config } from "../config.js";
import { loadTokens, type TokenRecord } from "./tokens.js";
import { readRange } from "./auditReader.js";
import { computeUsageStats, filterLinesByUser } from "./usage.js";
import { ADMIN_HEADERS, renderUserUsageView } from "./admin-templates.js";
import { parseRange } from "./usageRoute.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
const USAGE_WINDOW_DAYS = 90;
const USAGE_LINE_CAP = 50_000;

export function handleUserUsageGet(config: Config) {
  return (req: Request, res: Response) => {
    const userName = decodeURIComponent(req.params.userName ?? "");
    if (!userName) { res.status(404).type("text/plain").send("User not found"); return; }

    const now = Date.now();
    const range = parseRange(req.query as Record<string, unknown>);

    const from = new Date(now - USAGE_WINDOW_DAYS * ONE_DAY);
    const to = new Date(now);
    const rangeResult = readRange(config.SIMPRO_AUDIT_FILE, from, to, USAGE_LINE_CAP);

    const userLines = filterLinesByUser(rangeResult.lines, userName);
    const store = loadTokens(config.SIMPRO_TOKENS_FILE);

    let userMeta: TokenRecord | null = null;
    for (const rec of Object.values(store.tokens)) {
      if (rec.name === userName) { userMeta = rec; break; }
    }

    if (!userMeta && userLines.length === 0) {
      res.status(404).type("text/plain").send("User not found");
      return;
    }

    const stats = computeUsageStats(userLines, [userName], {
      now, truncated: rangeResult.truncated, rangeMs: range.rangeMs,
    });

    const adminName = (res.locals as { admin: { name: string } }).admin.name;
    for (const [k, v] of Object.entries(ADMIN_HEADERS)) res.set(k, v);
    res.type("text/html").send(renderUserUsageView({
      adminName, userName, userMeta, stats, now, range,
      recentLines: userLines.slice(-50).reverse(),
    }));
  };
}
