// Per-user bearer-token store for HTTP mode.
//
// The tokens file maps a randomly-generated bearer token -> a user record
// containing that user's own Simpro API key, name (for audit), and per-user
// safety flags. Storing real Simpro keys server-side keeps Simpro's audit
// log meaningful: every API call is attributed to the actual employee.
//
// File format (JSON):
//   {
//     "tokens": {
//       "smcp_<random>": {
//         "name": "Tayfun Yildirim",
//         "simproApiKey": "<their real Simpro API key>",
//         "companyAccess": ["plumbing", "energy"],   // or just one
//         "writeEnabled": false,                      // per-user write switch
//         "createdAt": "2026-05-04T..."
//       }
//     }
//   }
//
// The file is read fresh on every HTTP request (cheap — small JSON, hot in
// the OS file cache). That means add-user / revoke-user scripts take effect
// immediately without restarting the server.
//
// File permissions matter — the file holds secrets. The admin script should
// place it where only the service account can read it. On Windows running
// as a service, that's typically %ProgramData%\simpro-mcp\tokens.json with
// ACLs locked to the service identity.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type CompanyKey = "plumbing" | "energy";
const VALID_COMPANY_KEYS: ReadonlySet<CompanyKey> = new Set(["plumbing", "energy"]);

export interface TokenRecord {
  name: string;
  simproApiKey: string;
  companyAccess: CompanyKey[];
  writeEnabled?: boolean;
  createdAt?: string;
  lastUsedAt?: string;
  /** Provenance hint; defaults to "add-user.sh" when absent (back-compat). */
  enrolledVia?: "self-service" | "manual" | "add-user.sh";
  /** Admin flag for dashboard access. Defaults false when absent. */
  isAdmin?: boolean;
}

export interface TokensFile {
  tokens: Record<string, TokenRecord>;
}

export const COMPANY_IDS: Record<CompanyKey, string> = {
  plumbing: "4",
  energy: "37",
};

export function generateToken(): string {
  // 256 bits of entropy, URL-safe, prefixed for visual recognition in logs.
  const raw = crypto.randomBytes(32).toString("base64url");
  return `smcp_${raw}`;
}

// Cache the parsed tokens file by mtime — JSON.parse on every request is
// wasteful for chatty MCP sessions. Reload when the file changes (or when
// admin scripts touch it from outside this process).
let cache: { mtimeMs: number; data: TokensFile } | null = null;

/**
 * Validate a record loaded from JSON. We trust admin scripts but defend
 * against a hand-edited tokens.json that has e.g. `"companyAccess": "plumbing"`
 * (string instead of array) — `.includes("p")` would otherwise return true.
 */
function validateRecord(token: string, rec: unknown): TokenRecord {
  if (!rec || typeof rec !== "object") {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... is not an object`);
  }
  const r = rec as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name.length === 0) {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... missing "name"`);
  }
  if (typeof r.simproApiKey !== "string" || r.simproApiKey.length < 8) {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... missing/short "simproApiKey"`);
  }
  if (!Array.isArray(r.companyAccess) || r.companyAccess.length === 0) {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... "companyAccess" must be a non-empty array`);
  }
  for (const c of r.companyAccess) {
    if (typeof c !== "string" || !VALID_COMPANY_KEYS.has(c as CompanyKey)) {
      throw new Error(`tokens.json: record for ${token.slice(0, 8)}... has invalid companyAccess value: ${JSON.stringify(c)}`);
    }
  }
  // New: enrolledVia is optional but must be one of the known values if present.
  if (r.enrolledVia !== undefined &&
      r.enrolledVia !== "self-service" &&
      r.enrolledVia !== "manual" &&
      r.enrolledVia !== "add-user.sh") {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... has invalid enrolledVia: ${JSON.stringify(r.enrolledVia)}`);
  }
  // New: isAdmin is optional, must be boolean if present.
  if (r.isAdmin !== undefined && typeof r.isAdmin !== "boolean") {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... has non-boolean isAdmin: ${JSON.stringify(r.isAdmin)}`);
  }
  return {
    name: r.name,
    simproApiKey: r.simproApiKey,
    companyAccess: r.companyAccess as CompanyKey[],
    writeEnabled: r.writeEnabled === true,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined,
    lastUsedAt: typeof r.lastUsedAt === "string" ? r.lastUsedAt : undefined,
    enrolledVia: r.enrolledVia as TokenRecord["enrolledVia"],
    isAdmin: r.isAdmin === true,
  };
}

export function loadTokens(filePath: string): TokensFile {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    cache = null;
    return { tokens: {} };
  }
  const stat = fs.statSync(abs);
  if (cache && cache.mtimeMs === stat.mtimeMs) {
    return cache.data;
  }
  const raw = fs.readFileSync(abs, "utf8");
  const parsed = JSON.parse(raw) as TokensFile;
  if (!parsed || typeof parsed !== "object" || !parsed.tokens || typeof parsed.tokens !== "object") {
    throw new Error(`Invalid tokens file at ${abs}: missing "tokens" object`);
  }
  // Validate every record up-front so a malformed entry fails at load time,
  // not at first auth.
  const validated: Record<string, TokenRecord> = {};
  for (const [tok, rec] of Object.entries(parsed.tokens)) {
    validated[tok] = validateRecord(tok, rec);
  }
  const out: TokensFile = { tokens: validated };
  cache = { mtimeMs: stat.mtimeMs, data: out };
  return out;
}

export function saveTokens(filePath: string, data: TokensFile): void {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Write to a tmp file then rename, so a crash mid-write can't corrupt the
  // store. atomicity matters when the file holds live credentials.
  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, abs);
  // Invalidate cache so the next loadTokens picks up the new mtime cleanly.
  cache = null;
}

export interface AuthResult {
  ok: true;
  token: string;     // the matched token (for logging)
  record: TokenRecord;
}

export interface AuthFailure {
  ok: false;
  reason: string;
  status: number;
}

/**
 * Look up the bearer header against the tokens file. Returns either a match
 * or a structured failure with HTTP status to send back.
 */
export function authenticate(
  filePath: string,
  authorizationHeader: string | undefined,
): AuthResult | AuthFailure {
  if (!authorizationHeader) {
    return { ok: false, status: 401, reason: "Missing Authorization header" };
  }
  const m = /^Bearer\s+(.+?)\s*$/i.exec(authorizationHeader);
  if (!m) {
    return { ok: false, status: 401, reason: "Authorization must be a Bearer token" };
  }
  const token = m[1];
  let store: TokensFile;
  try {
    store = loadTokens(filePath);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      reason: `Server tokens file unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const record = store.tokens[token];
  if (!record) {
    return { ok: false, status: 401, reason: "Unknown token" };
  }
  return { ok: true, token, record };
}

/**
 * Update the lastUsedAt timestamp for a token. Best-effort; failures are
 * swallowed (we don't want a tokens-file write error to fail an actual
 * tool call). Throttled at most once per minute per token to avoid
 * excessive disk I/O during chatty sessions.
 *
 * Concurrency: a process-local promise chain serializes the read-mutate-write
 * sequence so two concurrent requests can't trample each other's lastUsedAt
 * (or worse, drop a record that add-user.sh just inserted between requests).
 * This does NOT defend against the server racing add-user.sh / revoke-user.sh
 * — admins should run those while the server is briefly stopped, or accept
 * that the next request might re-write a stale record. We force-reload from
 * disk inside the critical section to minimise the window.
 */
const LAST_USED_THROTTLE_MS = 60_000;
const lastTouchTimes = new Map<string, number>();
let writeChain: Promise<void> = Promise.resolve();
export function touchTokenLastUsed(filePath: string, token: string): void {
  const now = Date.now();
  const prev = lastTouchTimes.get(token) ?? 0;
  if (now - prev < LAST_USED_THROTTLE_MS) return;
  lastTouchTimes.set(token, now);
  writeChain = writeChain.then(async () => {
    try {
      // Bypass mtime cache: we want the absolute latest before mutating.
      cache = null;
      const store = loadTokens(filePath);
      if (!store.tokens[token]) return;
      store.tokens[token].lastUsedAt = new Date(now).toISOString();
      saveTokens(filePath, store);
    } catch {
      // Best-effort.
    }
  });
}

/**
 * Find a user record by their Simpro API key (the long-term identity).
 * Used for idempotent re-enrollment. Linear scan — fine at Goldman scale (<50 users).
 */
export function lookupBySimproKey(
  filePath: string,
  simproApiKey: string,
): { smcpToken: string; record: TokenRecord } | null {
  const store = loadTokens(filePath);
  for (const [smcpToken, record] of Object.entries(store.tokens)) {
    if (record.simproApiKey === simproApiKey) {
      return { smcpToken, record };
    }
  }
  return null;
}

/**
 * Insert a new record. Generates a fresh smcp_ token and returns it.
 * Caller is responsible for checking idempotency (call lookupBySimproKey first).
 */
export function addUser(
  filePath: string,
  partial: Omit<TokenRecord, "createdAt" | "lastUsedAt">,
): { smcpToken: string; record: TokenRecord } {
  const smcpToken = generateToken();
  const record: TokenRecord = {
    ...partial,
    createdAt: new Date().toISOString(),
  };
  // Bypass the mtime cache so we read the latest disk state before mutating.
  cache = null;
  const store = loadTokens(filePath);
  store.tokens[smcpToken] = record;
  saveTokens(filePath, store);
  return { smcpToken, record };
}

/**
 * Delete a record by smcp_ token. Returns true if it existed and was removed.
 */
export function removeUser(filePath: string, smcpToken: string): boolean {
  cache = null;
  const store = loadTokens(filePath);
  if (!(smcpToken in store.tokens)) return false;
  delete store.tokens[smcpToken];
  saveTokens(filePath, store);
  return true;
}

/**
 * Merge a partial patch into an existing record. Returns true if the record
 * exists. Used by the admin dashboard for "toggle write access" etc.
 */
export function updateUser(
  filePath: string,
  smcpToken: string,
  patch: Partial<Omit<TokenRecord, "simproApiKey" | "createdAt">>,
): boolean {
  cache = null;
  const store = loadTokens(filePath);
  if (!(smcpToken in store.tokens)) return false;
  store.tokens[smcpToken] = { ...store.tokens[smcpToken], ...patch };
  saveTokens(filePath, store);
  return true;
}
