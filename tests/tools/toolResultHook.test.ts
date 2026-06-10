// tests/tools/toolResultHook.test.ts
//
// Regression: the HTTP audit log recorded EVERY tool call as ok:true because
// server.ts judged success by "transport didn't throw" — but safeRun converts
// all Simpro errors into isError:true MCP responses, which never throw.
// Production evidence: journalctl showed 422s for add_section_cost_centre on
// 2026-06-08/09 while audit.log recorded those exact calls as ok:true.
//
// The fix: a per-server tool-result hook (setToolResultHook) that registerTool
// wraps around every handler, reporting the tool name + isError flag so the
// HTTP layer can audit the REAL outcome.

import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSiteTools } from "../../src/tools/sites.js";
import { SimproApiError } from "../../src/simpro/errors.js";
import {
  __resetSchemaCacheForTests,
  setToolResultHook,
  type ToolResultInfo,
  type ToolCtx,
} from "../../src/tools/_shared.js";

function ctxWith(get: (...a: unknown[]) => Promise<unknown>): ToolCtx {
  return {
    client: {
      companyPath: (p: string) => `/companies/0${p}`,
      get,
      post: async () => ({}),
      patch: async () => ({}),
    } as unknown as ToolCtx["client"],
    config: {
      SIMPRO_DEFAULT_PAGE_SIZE: 25,
      SIMPRO_ENABLE_WRITE_TOOLS: false,
      SIMPRO_DRY_RUN: true,
    } as unknown as ToolCtx["config"],
  };
}

async function callWithHook(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResultInfo[]> {
  const events: ToolResultInfo[] = [];
  const server = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  setToolResultHook(server, (r) => events.push(r));
  registerSiteTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
  return events;
}

describe("setToolResultHook — real tool outcome reaches the audit layer", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("reports isError:true when the Simpro call fails (safeRun-converted error)", async () => {
    const ctx = ctxWith(async () => {
      throw new SimproApiError({
        status: 422,
        method: "GET",
        endpoint: "/sites/",
        body: { errors: [{ message: "Invalid columns found" }] },
      });
    });
    const events = await callWithHook(ctx, "simpro_search_sites", { query: "Stawell" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "simpro_search_sites", isError: true });
    expect(events[0].errorText).toBeTruthy();
  });

  it("reports isError:false on success", async () => {
    const ctx = ctxWith(async () => ({ data: [] }));
    const events = await callWithHook(ctx, "simpro_search_sites", { query: "Stawell" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "simpro_search_sites", isError: false });
    expect(events[0].errorText).toBeUndefined();
  });
});
