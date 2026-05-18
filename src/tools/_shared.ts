import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Config } from "../config.js";
import { SimproClient } from "../simpro/client.js";
import { SimproApiError, SimproNetworkError } from "../simpro/errors.js";
import { log } from "../logger.js";
import { truncate, stripHtml } from "../utils/sanitise.js";

/**
 * Recursively walk a record and replace large HTML description/notes/details
 * blobs with a stripped, truncated plain-text preview. Skipped entirely when
 * the caller requested the raw record (raw=true on read tools / write echoes).
 * Only string fields whose KEY looks like description/notes/details, are
 * >200 chars, and contain a `<` are touched — names/addresses are left alone.
 */
function sanitiseRecordForOutput(value: unknown, keyHint?: string): unknown {
  if (typeof value === "string") {
    if (
      keyHint &&
      /description|notes?|details/i.test(keyHint) &&
      value.length > 200 &&
      value.includes("<")
    ) {
      // stripHtml truncates at `max`; ask for 501 so we can detect overflow.
      const stripped = stripHtml(value, Number.MAX_SAFE_INTEGER);
      const clipped = stripped.slice(0, 500);
      return stripped.length > 500
        ? clipped + " …[truncated; pass raw=true for full]"
        : clipped;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitiseRecordForOutput(v, keyHint));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitiseRecordForOutput(v, k);
    }
    return out;
  }
  return value;
}

export interface ToolCtx {
  client: SimproClient;
  config: Config;
}

export interface McpTextResponse {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Per-request cost optimisation for the stateless HTTP transport.
 *
 * Every JSON-RPC POST builds a fresh `McpServer` (required — the MCP SDK binds
 * one mutable transport per Protocol instance, so a shared server would
 * misroute concurrent users' responses). `registerAllTools` then runs on every
 * request, and each of the ~61 `server.tool(...)` calls used to allocate a
 * brand-new `z.object` schema tree from an inline shape literal, which the SDK
 * then re-wraps via `objectFromShape`. That zod construction is pure and
 * **identical for every user** — a tool's input schema never depends on the
 * per-user SimproClient/config (only the handler closure does).
 *
 * `registerTool` memoises the built raw shape **once per tool name, for the
 * process lifetime**, keyed by the (globally-unique) tool name. The shape
 * factory runs exactly once ever; thereafter the cached shape (an object of
 * already-constructed `z.*` schemas) is reused on every request, so the ~61
 * zod schema trees are built one time at first use instead of per request.
 *
 * The legacy `server.tool(name, desc, rawShape, handler)` overload requires a
 * raw shape (the SDK's `isZodRawShapeCompat` rejects a `z.object` instance), so
 * the cache stores the raw shape; the SDK's cheap per-call `objectFromShape`
 * wrap still runs but the expensive tree construction does not.
 *
 * SAFETY: only the user-INDEPENDENT input shape is cached. The handler — which
 * closes over the per-request `ctx` (SimproClient + user config) — is created
 * fresh on every call from the per-request `handlerFactory`. Nothing that
 * captures a user's client/config is ever shared across requests.
 */
const schemaCache = new Map<string, z.ZodRawShape>();

/** Visible for tests: how many times a shape factory was actually invoked. */
export const __schemaBuildCounts = new Map<string, number>();

export function __resetSchemaCacheForTests(): void {
  schemaCache.clear();
  __schemaBuildCounts.clear();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any) => Promise<McpTextResponse>;

export function registerTool(
  server: McpServer,
  name: string,
  description: string,
  shapeFactory: () => z.ZodRawShape,
  handlerFactory: () => ToolHandler,
): void {
  let shape = schemaCache.get(name);
  if (!shape) {
    shape = shapeFactory();
    schemaCache.set(name, shape);
    __schemaBuildCounts.set(name, (__schemaBuildCounts.get(name) ?? 0) + 1);
  }
  // Handler is rebuilt per request — it captures the per-user ctx.
  (server.tool as unknown as (
    n: string,
    d: string,
    s: z.ZodRawShape,
    h: ToolHandler,
  ) => void)(name, description, shape, handlerFactory());
}

export function textResponse(text: string, isError = false): McpTextResponse {
  return { content: [{ type: "text", text }], isError };
}

export function jsonBlock(label: string, value: unknown, max = 8000): string {
  const json = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `${label}:\n\`\`\`json\n${truncate(json, max)}\n\`\`\``;
}

/**
 * Gate a write/update operation. Returns either a blocking MCP response
 * (when writes disabled, unconfirmed, or dry-run), or null to proceed.
 */
export function writeGuard(
  ctx: ToolCtx,
  args: {
    confirm: boolean;
    method: string;
    path: string;
    payload: unknown;
    summary: string;
  },
): McpTextResponse | null {
  if (!ctx.config.SIMPRO_ENABLE_WRITE_TOOLS) {
    return textResponse(
      "Write tools are disabled. Set SIMPRO_ENABLE_WRITE_TOOLS=true in your .env (or Claude Desktop config) and restart the server to enable create/update tools.",
    );
  }
  if (args.confirm !== true) {
    return textResponse(
      [
        "Confirmation required. Review the planned change below and re-run with `confirm: true` to proceed.",
        "",
        `Action: ${args.summary}`,
        `Method: ${args.method}`,
        `Endpoint: ${args.path}`,
        jsonBlock("Planned payload", args.payload),
      ].join("\n"),
    );
  }
  if (ctx.config.SIMPRO_DRY_RUN) {
    return textResponse(
      [
        "DRY RUN — no request was sent to Simpro. Set SIMPRO_DRY_RUN=false to send real requests.",
        "",
        `Action: ${args.summary}`,
        `Method: ${args.method}`,
        `Endpoint: ${args.path}`,
        jsonBlock("Planned payload", args.payload),
      ].join("\n"),
    );
  }
  return null;
}

/** Wrap a tool body so any thrown error becomes a clean MCP text response. */
export async function safeRun(fn: () => Promise<McpTextResponse>): Promise<McpTextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SimproApiError) {
      log.error(`Simpro API error: ${err.status} ${err.method} ${err.endpoint}`);
      return textResponse(err.toUserMessage(), true);
    }
    if (err instanceof SimproNetworkError) {
      log.error(`Simpro network error: ${err.message}`);
      return textResponse(err.message, true);
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Unexpected tool error: ${message}`);
    return textResponse(`Unexpected error: ${message}`, true);
  }
}

/** Format a paginated list result into a concise text + raw block. */
export function formatList<T>(
  items: T[],
  total: number | undefined,
  page: number,
  pageSize: number,
  formatRow: (item: T) => string,
  raw: unknown,
  includeRaw: boolean,
): McpTextResponse {
  const header =
    total !== undefined
      ? `Page ${page} (size ${pageSize}) — showing ${items.length} of ${total} total.`
      : `Page ${page} (size ${pageSize}) — ${items.length} result(s).`;
  const rows = items.length === 0 ? "(no results)" : items.map((it) => `- ${formatRow(it)}`).join("\n");
  const parts = [header, "", rows];
  if (includeRaw) parts.push("", jsonBlock("Raw response", raw));
  return textResponse(parts.join("\n"));
}

export function formatRecord(label: string, record: unknown, raw: unknown, includeRaw: boolean): McpTextResponse {
  // includeRaw === true means the caller asked for the full untrimmed record
  // (read tool raw=true, or a write echo). Otherwise strip giant HTML blobs.
  const shown = includeRaw ? record : sanitiseRecordForOutput(record);
  const parts = [label, "", jsonBlock("Record", shown)];
  if (includeRaw && raw !== record) parts.push("", jsonBlock("Raw response", raw));
  return textResponse(parts.join("\n"));
}

/** Best-effort: extract an array of items from a Simpro response. */
export function extractList(resp: unknown): unknown[] {
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    for (const key of ["data", "items", "results"]) {
      if (Array.isArray(r[key])) return r[key] as unknown[];
    }
  }
  return [];
}
