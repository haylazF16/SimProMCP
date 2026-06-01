// tests/tools/jobsColumns.test.ts
//
// Regression: pin the request shape sent to Simpro for tools targeting the
// /jobs/ list endpoint. Background: commits fa7959d and 90a3e8c removed the
// `columns=` selectors from `simpro_search_jobs`, `simpro_list_job_statuses`,
// and `simpro_list_job_types` after the Goldman Plumbing tenant started
// returning 400 "Invalid columns: JobNumber" (and the symmetric risk applies
// to Status and Type on the same endpoint). This test pins those request
// shapes so a well-meaning future "re-add the perf optimisation" PR fails in
// CI instead of in production.

import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerJobTools } from "../../src/tools/jobs.js";
import {
  __resetSchemaCacheForTests,
  type ToolCtx,
} from "../../src/tools/_shared.js";

interface CapturedCall {
  path: string;
  query: Record<string, unknown> | undefined;
}

function fakeCtxWithSpy(): { ctx: ToolCtx; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const ctx = {
    client: {
      companyPath: (p: string) => `/companies/0${p}`,
      // The tools under test only call get(). Other verbs are stubbed to
      // throw — if a refactor accidentally routes a read through patch/post,
      // the test fails loudly instead of silently passing.
      get: async (path: string, query?: Record<string, unknown>) => {
        calls.push({ path, query });
        return { data: [] };
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
): Promise<void> {
  const server = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerJobTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("Simpro /jobs/ tools — request shape (no columns= selector)", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("simpro_search_jobs sends no `columns` key on its GET /jobs/", async () => {
    const { ctx, calls } = fakeCtxWithSpy();
    await callTool(ctx, "simpro_search_jobs", {});
    const get = calls.find((c) => c.path.endsWith("/jobs/"));
    expect(get, "expected a GET against /jobs/").toBeDefined();
    expect(get!.query).toBeDefined();
    expect(get!.query!).not.toHaveProperty("columns");
  });

  it("simpro_list_job_statuses sends no `columns` key on its GET /jobs/", async () => {
    const { ctx, calls } = fakeCtxWithSpy();
    await callTool(ctx, "simpro_list_job_statuses", {});
    const get = calls.find((c) => c.path.endsWith("/jobs/"));
    expect(get, "expected a GET against /jobs/").toBeDefined();
    expect(get!.query).toBeDefined();
    expect(get!.query!).not.toHaveProperty("columns");
  });

  it("simpro_list_job_types sends no `columns` key on its GET /jobs/", async () => {
    const { ctx, calls } = fakeCtxWithSpy();
    await callTool(ctx, "simpro_list_job_types", {});
    const get = calls.find((c) => c.path.endsWith("/jobs/"));
    expect(get, "expected a GET against /jobs/").toBeDefined();
    expect(get!.query).toBeDefined();
    expect(get!.query!).not.toHaveProperty("columns");
  });
});
