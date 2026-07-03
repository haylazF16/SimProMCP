import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerContactTools } from "../../src/tools/contacts.js";
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
        return { ID: 321, GivenName: "Jane" };
      },
      patch: async (p: string, payload: unknown) => {
        spy.patches.push({ path: p, payload });
        return { ID: 321 };
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
  registerContactTools(server, ctx);
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

describe("simpro_create_contact", () => {
  it("POSTs mapped payload to /contacts/ when confirmed", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_contact", {
      confirm: true, givenName: "Jane", familyName: "Doe", email: "jane@x.com",
    });
    expect(r.isError).toBe(false);
    expect(spy.posts).toHaveLength(1);
    expect(spy.posts[0].path).toBe("/api/v1.0/companies/4/contacts/");
    expect(spy.posts[0].payload).toEqual({ GivenName: "Jane", FamilyName: "Doe", Email: "jane@x.com" });
    expect(r.text).toContain("#321");
  });

  it("blocks without confirm and echoes payload", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_contact", { confirm: false, givenName: "Jane" });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("Confirmation required");
    expect(r.text).toContain("GivenName");
  });

  it("blocks when write tools disabled", async () => {
    const { ctx, spy } = makeCtx({ write: false });
    const r = await callTool(ctx, "simpro_create_contact", { confirm: true, givenName: "Jane" });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("Write tools are disabled");
  });

  it("dry-run echoes payload without sending", async () => {
    const { ctx, spy } = makeCtx({ dryRun: true });
    const r = await callTool(ctx, "simpro_create_contact", { confirm: true, givenName: "Jane" });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("DRY RUN");
  });

  it("rawPayload bypasses field mapping", async () => {
    const { ctx, spy } = makeCtx();
    await callTool(ctx, "simpro_create_contact", {
      confirm: true, givenName: "ignored", rawPayload: { GivenName: "Raw", CustomField: 1 },
    });
    expect(spy.posts[0].payload).toEqual({ GivenName: "Raw", CustomField: 1 });
  });
});

describe("simpro_update_contact", () => {
  it("PATCHes mapped payload to /contacts/{id} when confirmed", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_update_contact", {
      confirm: true, contactId: 321, email: "new@x.com",
    });
    expect(r.isError).toBe(false);
    expect(spy.patches).toHaveLength(1);
    expect(spy.patches[0].path).toBe("/api/v1.0/companies/4/contacts/321");
    expect(spy.patches[0].payload).toEqual({ Email: "new@x.com" });
  });

  it("rejects an empty update (no fields, no rawPayload)", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_update_contact", { confirm: true, contactId: 321 });
    expect(spy.patches).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No fields to update");
  });

  it("blocks when write tools disabled", async () => {
    const { ctx, spy } = makeCtx({ write: false });
    const r = await callTool(ctx, "simpro_update_contact", { confirm: true, contactId: 321, email: "a@b.co" });
    expect(spy.patches).toHaveLength(0);
    expect(r.text).toContain("Write tools are disabled");
  });

  it("dry-run echoes without sending", async () => {
    const { ctx, spy } = makeCtx({ dryRun: true });
    const r = await callTool(ctx, "simpro_update_contact", { confirm: true, contactId: 321, email: "a@b.co" });
    expect(spy.patches).toHaveLength(0);
    expect(r.text).toContain("DRY RUN");
  });
});

describe("simpro_create_lead", () => {
  it("POSTs mapped payload to /leads/ when confirmed", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_lead", {
      confirm: true, leadName: "New bathroom fit-out", customerId: 55, siteId: 9, salespersonId: 3,
    });
    expect(r.isError).toBe(false);
    expect(spy.posts).toHaveLength(1);
    expect(spy.posts[0].path).toBe("/api/v1.0/companies/4/leads/");
    expect(spy.posts[0].payload).toEqual({
      LeadName: "New bathroom fit-out", Customer: 55, Site: 9, Salesperson: 3,
    });
  });

  it("blocks without confirm", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_lead", { confirm: false, leadName: "X" });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("Confirmation required");
  });
});

describe("simpro_update_lead", () => {
  it("PATCHes to /leads/{id} when confirmed", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_update_lead", {
      confirm: true, leadId: 77, leadName: "Renamed lead",
    });
    expect(r.isError).toBe(false);
    expect(spy.patches[0].path).toBe("/api/v1.0/companies/4/leads/77");
    expect(spy.patches[0].payload).toEqual({ LeadName: "Renamed lead" });
  });

  it("rejects an empty update", async () => {
    const { ctx } = makeCtx();
    const r = await callTool(ctx, "simpro_update_lead", { confirm: true, leadId: 77 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No fields to update");
  });
});
