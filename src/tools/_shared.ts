import { Config } from "../config.js";
import { SimproClient } from "../simpro/client.js";
import { SimproApiError, SimproNetworkError } from "../simpro/errors.js";
import { log } from "../logger.js";
import { truncate } from "../utils/sanitise.js";

export interface ToolCtx {
  client: SimproClient;
  config: Config;
}

export interface McpTextResponse {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
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
  const parts = [label, "", jsonBlock("Record", record)];
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
