// All logs MUST go to stderr. Stdout is reserved for the MCP JSON-RPC stream.
// Never log raw API keys or full Authorization headers.
//
// Two layers of redaction:
//   1. TOKEN_PATTERN matches anything that looks like a credential — Simpro
//      hex API keys, smcp_<base64url> bearer tokens, or any base64url-ish
//      blob long enough to be a secret. We match WITH or WITHOUT a leading
//      "Bearer " so headers are also covered.
//   2. safeStringify also redacts well-known credential-bearing field names
//      so accidental JSON.stringify of a config object doesn't leak.

const TOKEN_PATTERN =
  /(Bearer\s+)?(smcp_[A-Za-z0-9_-]{16,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{40,})/g;

const REDACT_KEYS = new Set([
  "simproApiKey",
  "SIMPRO_API_KEY",
  "apiKey",
  "api_key",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "Authorization",
  "password",
]);

export function maskToken(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : safeStringify(value);
  return s.replace(TOKEN_PATTERN, (match, prefix) => {
    const tail = match.slice(-4);
    return `${prefix ?? ""}***${tail}`;
  });
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (key, val) => {
      if (REDACT_KEYS.has(key) && typeof val === "string" && val.length > 0) {
        return `***${val.slice(-4)}`;
      }
      return val;
    });
  } catch {
    return String(v);
  }
}

function emit(level: string, msg: string, extra?: unknown) {
  const line = extra === undefined
    ? `[${level}] ${maskToken(msg)}`
    : `[${level}] ${maskToken(msg)} ${maskToken(extra)}`;
  process.stderr.write(line + "\n");
}

export const log = {
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
  debug: (msg: string, extra?: unknown) => {
    if (process.env.SIMPRO_DEBUG === "true") emit("debug", msg, extra);
  },
};
