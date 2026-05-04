// All logs MUST go to stderr. Stdout is reserved for the MCP JSON-RPC stream.
// Never log raw API keys or full Authorization headers.

const TOKEN_PATTERN = /(Bearer\s+)?[A-Fa-f0-9]{20,}/g;

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
    return JSON.stringify(v);
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
