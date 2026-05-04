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

export interface TokenRecord {
  name: string;
  simproApiKey: string;
  companyAccess: CompanyKey[];
  writeEnabled?: boolean;
  createdAt?: string;
  lastUsedAt?: string;
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

export function loadTokens(filePath: string): TokensFile {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return { tokens: {} };
  }
  const raw = fs.readFileSync(abs, "utf8");
  const parsed = JSON.parse(raw) as TokensFile;
  if (!parsed || typeof parsed !== "object" || !parsed.tokens) {
    throw new Error(`Invalid tokens file at ${abs}: missing "tokens" object`);
  }
  return parsed;
}

export function saveTokens(filePath: string, data: TokensFile): void {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Write to a tmp file then rename, so a crash mid-write can't corrupt the
  // store. atomicity matters when the file holds live credentials.
  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8" });
  fs.renameSync(tmp, abs);
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
 */
const LAST_USED_THROTTLE_MS = 60_000;
const lastTouchTimes = new Map<string, number>();
export function touchTokenLastUsed(filePath: string, token: string): void {
  const now = Date.now();
  const prev = lastTouchTimes.get(token) ?? 0;
  if (now - prev < LAST_USED_THROTTLE_MS) return;
  lastTouchTimes.set(token, now);
  try {
    const store = loadTokens(filePath);
    if (!store.tokens[token]) return;
    store.tokens[token].lastUsedAt = new Date(now).toISOString();
    saveTokens(filePath, store);
  } catch {
    // Best-effort.
  }
}
