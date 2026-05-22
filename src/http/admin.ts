// src/http/admin.ts
// Admin dashboard for managing enrolled users. All routes are gated by
// requireAdmin which checks the admin's identity via either:
//   1. A session cookie (`goldman_admin_session=smcp_xxx`) set by /admin/login
//   2. An Authorization: Bearer header (for curl / API use)
//
// In both cases the smcp_ token must belong to a user whose tokens.json
// record has isAdmin=true.

import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { Config } from "../config.js";
import { log } from "../logger.js";
import { authenticate, loadTokens, removeUser, updateUser, type TokenRecord } from "./tokens.js";
import { enrollUser } from "./enroll.js";
import { readRange, tailLatest } from "./auditReader.js";
import {
  ADMIN_HEADERS,
  keyHash,
  renderDashboard,
  renderAuditView,
  renderManualCreatePage,
  renderManualCreateResult,
  renderLoginPage,
} from "./admin-templates.js";
import { handleUsageGet } from "./usageRoute.js";

/** Default lines shown when no date range is requested (tail of audit.log). */
const AUDIT_DEFAULT_LIMIT = 100;
/** Hard cap on lines returned when a date range IS specified. */
const AUDIT_RANGE_CAP = 5000;

/** Parse a YYYY-MM-DD query param into a Date (UTC midnight). Returns null if invalid. */
function parseDateParam(v: unknown, endOfDay: boolean): Date | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = endOfDay
    ? Date.UTC(y, mo - 1, d, 23, 59, 59, 999)
    : Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

const ADMIN_COOKIE = "goldman_admin_session";

/**
 * Parse a single cookie value out of the Cookie header. Returns undefined if
 * not present. We don't use a cookie-parser middleware to keep deps small —
 * this is the only place that reads cookies.
 */
function getCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (typeof raw !== "string") return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

type AdminResolveResult =
  | { ok: true; admin: { name: string; smcpToken: string } }
  | { ok: false; status: number; reason: string };

/**
 * Look up an smcp_ token (from cookie or Authorization header) and confirm
 * the matching record has isAdmin=true. Cookie takes precedence over header.
 */
function resolveAdmin(
  tokensFile: string,
  cookieToken: string | undefined,
  authHeader: string | undefined,
): AdminResolveResult {
  const header = cookieToken ? `Bearer ${cookieToken}` : authHeader;
  const auth = authenticate(tokensFile, header);
  if (!auth.ok) {
    return { ok: false, status: auth.status, reason: auth.reason };
  }
  if (auth.record.isAdmin !== true) {
    return { ok: false, status: 403, reason: "Admin access required." };
  }
  return { ok: true, admin: { name: auth.record.name, smcpToken: auth.token } };
}

export function requireAdmin(tokensFile: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const cookieToken = getCookie(req, ADMIN_COOKIE);
    const authHeader = req.headers["authorization"];
    const result = resolveAdmin(tokensFile, cookieToken, authHeader);
    if (!result.ok) {
      // If this looks like a browser navigation (GET, accepts HTML), bounce
      // to the login page instead of showing a bare 401/403. Skip for non-GET
      // (forms, API calls) — those get the status they earned.
      const wantsHtml =
        req.method === "GET" &&
        typeof req.headers.accept === "string" &&
        req.headers.accept.includes("text/html") &&
        req.path !== "/admin/login";
      if (wantsHtml) {
        res.redirect("/admin/login");
        return;
      }
      res.status(result.status).type("text/plain").send(result.reason);
      return;
    }
    (res.locals as { admin: { name: string; smcpToken: string } }).admin = result.admin;
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

  // GET /admin/login — show the login form
  // Note: NOT gated by `admin` middleware (would cause a redirect loop).
  router.get("/admin/login", (_req, res) => {
    withHeaders(res).type("text/html").send(renderLoginPage({}));
  });

  // POST /admin/login — validate the smcp_ token, set a session cookie,
  // redirect to /admin.
  router.post("/admin/login", (req, res) => {
    const body = req.body as { smcp_token?: string };
    const token = typeof body?.smcp_token === "string" ? body.smcp_token.trim() : "";
    if (!token) {
      withHeaders(res).type("text/html").send(renderLoginPage({ errorMessage: "Token required." }));
      return;
    }
    const resolved = resolveAdmin(config.SIMPRO_TOKENS_FILE, token, undefined);
    if (!resolved.ok) {
      withHeaders(res).type("text/html").send(renderLoginPage({
        errorMessage: "That token is either unknown or not an admin account.",
      }));
      return;
    }
    // Set the session cookie. HttpOnly so JS can't read it; Secure so it
    // only travels over HTTPS; SameSite=Strict so it can't be CSRF'd.
    // Max-Age 24h — admin re-logs in daily.
    res.set(
      "Set-Cookie",
      `${ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=86400`,
    );
    log.info(`admin.action actor=${sanitizeForLog(resolved.admin.name)} action=login`);
    res.redirect("/admin");
  });

  // POST /admin/logout — clear the session cookie.
  router.post("/admin/logout", (req, res) => {
    const cookieToken = getCookie(req, ADMIN_COOKIE);
    const who = cookieToken
      ? resolveAdmin(config.SIMPRO_TOKENS_FILE, cookieToken, undefined)
      : null;
    res.set(
      "Set-Cookie",
      `${ADMIN_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`,
    );
    if (who && who.ok) {
      log.info(`admin.action actor=${sanitizeForLog(who.admin.name)} action=logout`);
    }
    res.redirect("/admin/login");
  });

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

  // GET /admin/audit  (?from=YYYY-MM-DD&to=YYYY-MM-DD optional)
  // Without dates: tail the last 100 lines (cheap, default page load).
  // With dates: scan the current log + relevant monthly archives, return up
  // to 5000 matching entries.
  router.get("/admin/audit", admin, (req, res) => {
    const from = parseDateParam(req.query.from, false);
    const to = parseDateParam(req.query.to, true);
    const adminName = (res.locals as { admin: { name: string } }).admin.name;

    if (from && to && from.getTime() <= to.getTime()) {
      const result = readRange(config.SIMPRO_AUDIT_FILE, from, to, AUDIT_RANGE_CAP);
      withHeaders(res).type("text/html").send(
        renderAuditView(adminName, result.lines, {
          mode: "range",
          from: req.query.from as string,
          to: req.query.to as string,
          truncated: result.truncated,
          totalShown: result.lines.length,
          cap: AUDIT_RANGE_CAP,
          sources: result.sourcesRead,
        }),
      );
      return;
    }

    // Default: tail the live file. Cheap and quick on every page load.
    const lines = tailLatest(config.SIMPRO_AUDIT_FILE, AUDIT_DEFAULT_LIMIT);
    withHeaders(res).type("text/html").send(
      renderAuditView(adminName, lines, { mode: "tail", tailLimit: AUDIT_DEFAULT_LIMIT }),
    );
  });

  // GET /admin/usage — read-only analytics dashboard.
  router.get("/admin/usage", admin, handleUsageGet(config));

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
