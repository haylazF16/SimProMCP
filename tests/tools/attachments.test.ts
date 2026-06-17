import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAttachmentTools } from "../../src/tools/attachments.js";
import { __resetSchemaCacheForTests, type ToolCtx } from "../../src/tools/_shared.js";

interface Spy {
  gets: { path: string; query?: unknown }[];
  posts: { path: string; payload: unknown }[];
  dels: string[];
}

function makeCtx(over: Partial<{
  get: (p: string, q?: unknown) => Promise<unknown>;
  write: boolean;
  dryRun: boolean;
}> = {}): { ctx: ToolCtx; spy: Spy } {
  const spy: Spy = { gets: [], posts: [], dels: [] };
  const ctx = {
    client: {
      companyPath: (p: string) => `/api/v1.0/companies/4${p}`,
      get: async (p: string, q?: unknown) => {
        spy.gets.push({ path: p, query: q });
        return over.get ? over.get(p, q) : [];
      },
      post: async (p: string, payload: unknown) => {
        spy.posts.push({ path: p, payload });
        return { ID: 999 };
      },
      del: async (p: string) => {
        spy.dels.push(p);
        return {};
      },
    } as unknown as ToolCtx["client"],
    config: {
      SIMPRO_ENABLE_WRITE_TOOLS: over.write ?? true,
      SIMPRO_DRY_RUN: over.dryRun ?? false,
      SIMPRO_MAX_ATTACHMENT_MB: 20,
      SIMPRO_STAGING_DIR: "./staging",
    } as unknown as ToolCtx["config"],
  };
  return { ctx, spy };
}

async function callTool(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<string> {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerAttachmentTools(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
    };
    return res.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
  } finally {
    await client.close();
    await server.close();
  }
}

describe("simpro_list_attachments", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("lists files for a job", async () => {
    const { ctx, spy } = makeCtx({
      get: async () => [{ ID: 5, Filename: "photo.jpg", MimeType: "image/jpeg" }],
    });
    const out = await callTool(ctx, "simpro_list_attachments", { entityType: "job", entityId: 132277 });
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/jobs/132277/attachments/files/");
    expect(out).toContain("#5");
    expect(out).toContain("photo.jpg");
  });

  it("auto-resolves an invoice to its linked Job", async () => {
    const { ctx, spy } = makeCtx({
      get: async (p: string) => {
        if (p.includes("/invoices/")) return { ID: 80, Jobs: { ID: 132277 } };
        return [];
      },
    });
    await callTool(ctx, "simpro_list_attachments", { entityType: "invoice", entityId: 80 });
    // Second GET must target the JOB's attachment path, not the invoice's.
    expect(spy.gets.some((g) => g.path.endsWith("/jobs/132277/attachments/files/"))).toBe(true);
  });

  it("errors when an invoice has no linked Job", async () => {
    const { ctx } = makeCtx({ get: async () => ({ ID: 80 }) });
    const out = await callTool(ctx, "simpro_list_attachments", { entityType: "invoice", entityId: 80 });
    expect(out).toMatch(/no linked Job/i);
  });
});
