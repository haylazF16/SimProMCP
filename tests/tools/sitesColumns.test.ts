// tests/tools/sitesColumns.test.ts
//
// Regression: pin the request shape sent to Simpro for simpro_search_sites.
// Background: the /sites/ list endpoint returned 400 "Invalid columns found"
// because the tool requested a "Customer" column the endpoint doesn't expose
// (same class as JobNumber on /jobs/, see fa7959d). The fix dropped the
// columns= selector AND stopped passing CustomerID as a server-side filter
// param (Simpro silently ignores unknown list filters), moving customer
// filtering client-side. This test pins both invariants:
//   1. no `columns` key on the GET /sites/
//   2. no `CustomerID` key on the GET /sites/
// so a future "re-add the selector / re-add server-side filter" change fails
// in CI instead of in production.

import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSiteTools } from "../../src/tools/sites.js";
import {
  __resetSchemaCacheForTests,
  type ToolCtx,
} from "../../src/tools/_shared.js";

interface CapturedCall {
  path: string;
  query: Record<string, unknown> | undefined;
}

function fakeCtxWithSpy(siteRows: unknown[] = []): {
  ctx: ToolCtx;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const ctx = {
    client: {
      companyPath: (p: string) => `/companies/0${p}`,
      get: async (path: string, query?: Record<string, unknown>) => {
        calls.push({ path, query });
        // /customers/ (resolveCustomerByName) and /sites/ both route here.
        return { data: path.endsWith("/sites/") ? siteRows : [] };
      },
      post: async () => {
        throw new Error("post() should not be called by read tools");
      },
      patch: async () => {
        throw new Error("patch() should not be called by read tools");
      },
    } as unknown as ToolCtx["client"],
    config: {
      SIMPRO_DEFAULT_PAGE_SIZE: 25,
      SIMPRO_ENABLE_WRITE_TOOLS: false,
      SIMPRO_DRY_RUN: true,
    } as unknown as ToolCtx["config"],
  };
  return { ctx, calls };
}

async function callTool(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerSiteTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
    };
    return res.content.map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
    await server.close();
  }
}

describe("simpro_search_sites — request shape (no columns=, no CustomerID)", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("name search sends neither `columns` nor `CustomerID` on GET /sites/", async () => {
    const { ctx, calls } = fakeCtxWithSpy();
    await callTool(ctx, "simpro_search_sites", { query: "Stawell" });
    const get = calls.find((c) => c.path.endsWith("/sites/"));
    expect(get, "expected a GET against /sites/").toBeDefined();
    expect(get!.query).toBeDefined();
    expect(get!.query!).not.toHaveProperty("columns");
    expect(get!.query!).not.toHaveProperty("CustomerID");
  });

  it("customerId search still sends no `CustomerID` server-side param (filtered client-side)", async () => {
    const { ctx, calls } = fakeCtxWithSpy();
    await callTool(ctx, "simpro_search_sites", { customerId: 123 });
    const get = calls.find((c) => c.path.endsWith("/sites/"));
    expect(get, "expected a GET against /sites/").toBeDefined();
    expect(get!.query!).not.toHaveProperty("columns");
    expect(get!.query!).not.toHaveProperty("CustomerID");
  });

  it("filters by customer client-side, matching the Customers[] array shape", async () => {
    // Site #1 belongs to customer 123 via the Customers[] array shape;
    // site #2 belongs to a different customer. Filtering by 123 must keep
    // only #1 — proving the filter reads the array, not just a singular ref,
    // even though the GET sent no server-side customer filter.
    const rows = [
      { ID: 1, Name: "Stawell Depot", Customers: [{ Customer: { ID: 123, Name: "Acme" } }] },
      { ID: 2, Name: "Other Site", Customers: [{ Customer: { ID: 999, Name: "Beta" } }] },
    ];
    const { ctx, calls } = fakeCtxWithSpy(rows);
    const out = await callTool(ctx, "simpro_search_sites", { customerId: 123 });
    const get = calls.find((c) => c.path.endsWith("/sites/"));
    expect(get!.query!).not.toHaveProperty("CustomerID");
    // The rendered result includes the matching site and excludes the other.
    expect(out).toContain("Stawell Depot");
    expect(out).not.toContain("Other Site");
    // And the matched customer name is surfaced from the array ref.
    expect(out).toContain("customer: Acme");
  });
});
