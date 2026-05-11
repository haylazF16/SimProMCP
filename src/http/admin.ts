// src/http/admin.ts
// Admin dashboard for managing enrolled users. All routes are gated by
// requireAdmin which checks the smcp_ token's isAdmin flag in tokens.json.

import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import * as fs from "node:fs";
import { Config } from "../config.js";
import { log } from "../logger.js";
import { authenticate, loadTokens, removeUser, updateUser, type TokenRecord } from "./tokens.js";
import { enrollUser } from "./enroll.js";
import {
  ADMIN_HEADERS,
  keyHash,
  renderDashboard,
  renderAuditView,
  renderManualCreatePage,
  renderManualCreateResult,
} from "./admin-templates.js";

export function requireAdmin(tokensFile: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = authenticate(tokensFile, req.headers["authorization"]);
    if (!auth.ok) {
      res.status(auth.status).type("text/plain").send(auth.reason);
      return;
    }
    if (auth.record.isAdmin !== true) {
      res.status(403).type("text/plain").send("Admin access required.");
      return;
    }
    (res.locals as { admin: { name: string; smcpToken: string } }).admin = {
      name: auth.record.name,
      smcpToken: auth.token,
    };
    next();
  };
}

function withHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(ADMIN_HEADERS)) res.set(k, v);
  return res;
}

/** Strip control chars from a string before logging to prevent log forgery. */
function sanitizeForLog(s: string): string {
  return s.replace(/[\r\n\t]/g, " ").slice(0, 100);
}

function findUserByKeyHash(tokensFile: string, hash: string): { smcpToken: string; record: TokenRecord } | null {
  const store = loadTokens(tokensFile);
  for (const [smcpToken, record] of Object.entries(store.tokens)) {
    if (keyHash(record.simproApiKey) === hash) return { smcpToken, record };
  }
  return null;
}

export function attachAdminRoutes(router: Router, config: Config): void {
  const admin = requireAdmin(config.SIMPRO_TOKENS_FILE);

  // GET /admin — user list
  router.get("/admin", admin, (_req, res) => {
    const store = loadTokens(config.SIMPRO_TOKENS_FILE);
    const users = Object.entries(store.tokens).map(([smcpToken, record]) => ({ smcpToken, record }));
    const adminName = (res.locals as { admin: { name: string } }).admin.name;
    withHeaders(res).type("text/html").send(renderDashboard(adminName, users));
  });

  // POST /admin/users/:hash/revoke
  router.post("/admin/users/:hash/revoke", admin, async (req, res) => {
    const found = findUserByKeyHash(config.SIMPRO_TOKENS_FILE, req.params.hash);
    if (!found) {
      res.status(404).type("text/plain").send("User not found");
      return;
    }
    const actor = (res.locals as { admin: { name: string } }).admin.name;
    const ok = await removeUser(config.SIMPRO_TOKENS_FILE, found.smcpToken);
    log.info(`admin.action actor=${sanitizeForLog(actor)} action=revoke target=${sanitizeForLog(found.record.name)} ok=${ok}`);
    res.redirect("/admin");
  });

  // POST /admin/users/:hash/toggle-write
  router.post("/admin/users/:hash/toggle-write", admin, async (req, res) => {
    const found = findUserByKeyHash(config.SIMPRO_TOKENS_FILE, req.params.hash);
    if (!found) {
      res.status(404).type("text/plain").send("User not found");
      return;
    }
    const nextValue = !(found.record.writeEnabled ?? false);
    const actor = (res.locals as { admin: { name: string } }).admin.name;
    await updateUser(config.SIMPRO_TOKENS_FILE, found.smcpToken, { writeEnabled: nextValue });
    log.info(`admin.action actor=${sanitizeForLog(actor)} action=toggle-write target=${sanitizeForLog(found.record.name)} newValue=${nextValue}`);
    res.redirect("/admin");
  });

  // GET /admin/audit
  router.get("/admin/audit", admin, (_req, res) => {
    let lines: string[] = [];
    try {
      const raw = fs.readFileSync(config.SIMPRO_AUDIT_FILE, "utf8");
      lines = raw.split("\n").filter((l) => l.length > 0).slice(-100);
    } catch {
      // File may not exist yet — fine.
    }
    const adminName = (res.locals as { admin: { name: string } }).admin.name;
    withHeaders(res).type("text/html").send(renderAuditView(adminName, lines));
  });

  // GET /admin/users/new — manual create form
  router.get("/admin/users/new", admin, (_req, res) => {
    withHeaders(res).type("text/html").send(renderManualCreatePage());
  });

  // POST /admin/users — manual create submission
  router.post("/admin/users", admin, async (req, res) => {
    const { name, simpro_key } = req.body as { name?: string; simpro_key?: string };
    if (!name || !simpro_key) {
      withHeaders(res).type("text/html").send(renderManualCreatePage({
        errorMessage: "Both name and Simpro key required.",
        submittedName: name,
      }));
      return;
    }
    const result = await enrollUser({
      tokensFile: config.SIMPRO_TOKENS_FILE,
      simproBaseUrl: config.SIMPRO_BASE_URL,
      simproApiKey: simpro_key.trim(),
      submittedName: name.trim(),
      via: "manual",
    });
    if (!result.ok) {
      const messages: Record<string, string> = {
        invalid_key: "Simpro rejected that key.",
        simpro_unreachable: "Couldn't reach Simpro. Try again.",
        no_company_access: "Key has no access to Plumbing or Energy.",
        name_required: "Name required.",
        unexpected_status: "Simpro returned an unexpected response.",
      };
      withHeaders(res).type("text/html").send(renderManualCreatePage({
        errorMessage: messages[result.reason] ?? `Error: ${result.reason}`,
        submittedName: name,
        submittedKey: simpro_key,
      }));
      return;
    }
    const actor = (res.locals as { admin: { name: string } }).admin.name;
    log.info(`admin.action actor=${sanitizeForLog(actor)} action=create target=${sanitizeForLog(result.record.name)} idempotent=${result.wasIdempotent}`);
    withHeaders(res).type("text/html").send(renderManualCreateResult(result.record, result.smcpToken));
  });
}
