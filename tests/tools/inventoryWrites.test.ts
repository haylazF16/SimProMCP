import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerInventoryTools } from "../../src/tools/inventory.js";
import type { ToolCtx } from "../../src/tools/_shared.js";

interface Spy {
  posts: { path: string; payload: unknown }[];
  patches: { path: string; payload: unknown }[];
}

function makeCtx(over: Partial<{ write: boolean; dryRun: boolean }> = {}): { ctx: ToolCtx; spy: Spy } {
  const spy: Spy = { posts: [], patches: [] };
  const ctx = {
    client: {
      companyPath: (p: string) => `/api/v1.0/companies/4${p}`,
      get: async () => [],
      post: async (p: string, payload: unknown) => {
        spy.posts.push({ path: p, payload });
        return { ID: 42 };
      },
      patch: async (p: string, payload: unknown) => {
        spy.patches.push({ path: p, payload });
        return { ID: 42 };
      },
    } as unknown as ToolCtx["client"],
    config: {
      SIMPRO_ENABLE_WRITE_TOOLS: over.write ?? true,
      SIMPRO_DRY_RUN: over.dryRun ?? false,
      SIMPRO_DEFAULT_PAGE_SIZE: 20,
      SIMPRO_MAX_PAGE_SIZE: 100,
    } as unknown as ToolCtx["config"],
  };
  return { ctx, spy };
}

async function callTool(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerInventoryTools(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { text: res.content?.[0]?.text ?? "", isError: res.isError === true };
  } finally {
    await client.close();
  }
}

describe("simpro_create_storage_device", () => {
  it("POSTs mapped payload when confirmed", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_storage_device", {
      confirm: true, name: "Van 7", type: "Vehicle",
    });
    expect(r.isError).toBe(false);
    expect(spy.posts[0].path).toBe("/api/v1.0/companies/4/storageDevices/");
    expect(spy.posts[0].payload).toEqual({ Name: "Van 7", Type: "Vehicle" });
  });

  it("blocks without confirm", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_storage_device", { confirm: false, name: "X" });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("Confirmation required");
  });

  it("blocks when writes disabled", async () => {
    const { ctx, spy } = makeCtx({ write: false });
    const r = await callTool(ctx, "simpro_create_storage_device", { confirm: true, name: "X" });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("Write tools are disabled");
  });

  it("dry-run echoes without sending", async () => {
    const { ctx, spy } = makeCtx({ dryRun: true });
    const r = await callTool(ctx, "simpro_create_storage_device", { confirm: true, name: "X" });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("DRY RUN");
  });
});

describe("simpro_update_storage_device", () => {
  it("PATCHes to /storageDevices/{id}", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_update_storage_device", {
      confirm: true, storageDeviceId: 8, name: "Van 7 (renamed)",
    });
    expect(r.isError).toBe(false);
    expect(spy.patches[0].path).toBe("/api/v1.0/companies/4/storageDevices/8");
    expect(spy.patches[0].payload).toEqual({ Name: "Van 7 (renamed)" });
  });

  it("rejects an empty update", async () => {
    const { ctx } = makeCtx();
    const r = await callTool(ctx, "simpro_update_storage_device", { confirm: true, storageDeviceId: 8 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No fields to update");
  });
});

describe("simpro_create_stock_take", () => {
  it("POSTs mapped payload when confirmed", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_stock_take", {
      confirm: true, storageDeviceId: 8,
    });
    expect(r.isError).toBe(false);
    expect(spy.posts[0].path).toBe("/api/v1.0/companies/4/stockTakes/");
    expect(spy.posts[0].payload).toEqual({ StorageDevice: 8 });
  });

  it("blocks without confirm", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_stock_take", { confirm: false, storageDeviceId: 8 });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("Confirmation required");
  });
});

describe("simpro_update_stock_take", () => {
  it("PATCHes rawPayload to /stockTakes/{id}", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_update_stock_take", {
      confirm: true, stockTakeId: 5, rawPayload: { Status: "Complete" },
    });
    expect(r.isError).toBe(false);
    expect(spy.patches[0].path).toBe("/api/v1.0/companies/4/stockTakes/5");
    expect(spy.patches[0].payload).toEqual({ Status: "Complete" });
  });

  it("dry-run echoes without sending", async () => {
    const { ctx, spy } = makeCtx({ dryRun: true });
    const r = await callTool(ctx, "simpro_update_stock_take", {
      confirm: true, stockTakeId: 5, rawPayload: { Status: "Complete" },
    });
    expect(spy.patches).toHaveLength(0);
    expect(r.text).toContain("DRY RUN");
  });
});
