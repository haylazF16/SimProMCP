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

import * as os from "node:os";
import * as nodePath from "node:path";
import { promises as fsp } from "node:fs";

describe("simpro_upload_attachment", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("is blocked when writes are disabled", async () => {
    const { ctx, spy } = makeCtx({ write: false });
    const out = await callTool(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ sourceUrl: "https://e.com/a.pdf" }],
    });
    expect(out).toMatch(/Write tools are disabled/i);
    expect(spy.posts).toHaveLength(0);
  });

  it("requires confirm:true (preview, no POST)", async () => {
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_upload_attachment", {
      confirm: false,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: "/tmp/whatever.pdf" }],
    });
    expect(out).toMatch(/Confirmation required/i);
    expect(spy.posts).toHaveLength(0);
  });

  it("uploads a local file and reports per-file success", async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "up-"));
    const p = nodePath.join(dir, "docket.pdf");
    await fsp.writeFile(p, "PDF");
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 132277,
      files: [{ filePath: p }],
      public: false,
    });
    expect(spy.posts[0].path).toBe("/api/v1.0/companies/4/jobs/132277/attachments/files/");
    const payload = spy.posts[0].payload as Record<string, unknown>;
    expect(payload.Filename).toBe("docket.pdf");
    expect(payload.Public).toBe(false);
    expect(Buffer.from(payload.Base64Data as string, "base64").toString()).toBe("PDF");
    expect(out).toMatch(/1 uploaded, 0 failed/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("continues a batch past one bad file (partial failure)", async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "up-"));
    const good = nodePath.join(dir, "ok.txt");
    await fsp.writeFile(good, "ok");
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: good }, { filePath: nodePath.join(dir, "missing.txt") }],
    });
    expect(spy.posts).toHaveLength(1); // only the good file POSTed
    expect(out).toMatch(/1 uploaded, 1 failed/);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe("simpro_download_attachment", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  function fileRecord(name: string, mime: string, text: string) {
    return { Filename: name, MimeType: mime, Base64Data: Buffer.from(text).toString("base64") };
  }

  it("requests the file with display=Base64 and returns metadata-only by default for non-images", async () => {
    const { ctx, spy } = makeCtx({ get: async () => fileRecord("report.pdf", "application/pdf", "PDF") });
    const out = await callTool(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5 }],
    });
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/jobs/1/attachments/files/5");
    expect(spy.gets[0].query).toEqual({ display: "Base64" });
    expect(out).toMatch(/metadata/i);
    expect(out).toContain("report.pdf");
  });

  it("returns an inline image content block for image/* files", async () => {
    const { ctx } = makeCtx({ get: async () => fileRecord("photo.png", "image/png", "PNGBYTES") });
    const out = await callTool(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 7 }],
    });
    // callTool renders an image content block as "[image]".
    expect(out).toContain("[image]");
  });

  it("writes to saveDir when given and reports the path", async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "dl-"));
    const { ctx } = makeCtx({ get: async () => fileRecord("docket.pdf", "application/pdf", "PDF") });
    const out = await callTool(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 9 }],
      saveDir: dir,
    });
    expect(out).toMatch(/saved/i);
    const written = await fsp.readFile(nodePath.join(dir, "docket.pdf"), "utf8");
    expect(written).toBe("PDF");
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe("simpro_delete_attachment", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("requires confirm:true (no DELETE on preview)", async () => {
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_delete_attachment", {
      confirm: false,
      entityType: "job",
      entityId: 1,
      fileIds: [5],
    });
    expect(out).toMatch(/Confirmation required/i);
    expect(spy.dels).toHaveLength(0);
  });

  it("deletes each fileId and reports the count", async () => {
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_delete_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 132277,
      fileIds: [5, 6],
    });
    expect(spy.dels).toEqual([
      "/api/v1.0/companies/4/jobs/132277/attachments/files/5",
      "/api/v1.0/companies/4/jobs/132277/attachments/files/6",
    ]);
    expect(out).toMatch(/2 deleted, 0 failed/);
  });
});
