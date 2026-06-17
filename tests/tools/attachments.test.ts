import { describe, it, expect, beforeEach } from "vitest";
import * as os from "node:os";
import * as nodePath from "node:path";
import { promises as fsp } from "node:fs";
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
  del: (p: string) => Promise<unknown>;
  write: boolean;
  dryRun: boolean;
  transport: "stdio" | "http";
  downloadDir: string;
  stagingDir: string;
  maxMb: number;
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
        return over.del ? over.del(p) : {};
      },
    } as unknown as ToolCtx["client"],
    config: {
      SIMPRO_ENABLE_WRITE_TOOLS: over.write ?? true,
      SIMPRO_DRY_RUN: over.dryRun ?? false,
      SIMPRO_MAX_ATTACHMENT_MB: over.maxMb ?? 20,
      SIMPRO_STAGING_DIR: over.stagingDir ?? "./staging",
      SIMPRO_DOWNLOAD_DIR: over.downloadDir ?? "./downloads",
      SIMPRO_TRANSPORT: over.transport ?? "stdio",
    } as unknown as ToolCtx["config"],
  };
  return { ctx, spy };
}

interface RawResult {
  text: string;
  isError: boolean;
}

async function withTool<T>(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
  map: (res: { content: { type: string; text?: string }[]; isError?: boolean }) => T,
): Promise<T> {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerAttachmentTools(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return map(res);
  } finally {
    await client.close();
    await server.close();
  }
}

/** Convenience: flatten content blocks to a single string (images become "[image]"). */
function callTool(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<string> {
  return withTool(ctx, name, args, (res) => res.content.map((c) => c.text ?? `[${c.type}]`).join("\n"));
}

/** Like callTool but exposes the MCP isError flag so we can assert audit honesty. */
function callToolRaw(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<RawResult> {
  return withTool(ctx, name, args, (res) => ({
    text: res.content.map((c) => c.text ?? `[${c.type}]`).join("\n"),
    isError: res.isError === true,
  }));
}

async function tmpDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

function fileRecord(name: string, mime: string, text: string) {
  return { Filename: name, MimeType: mime, Base64Data: Buffer.from(text).toString("base64") };
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

  it("targets the correct path for a non-Job entity (quote)", async () => {
    const { ctx, spy } = makeCtx({ get: async () => [{ ID: 1, Filename: "q.pdf" }] });
    await callTool(ctx, "simpro_list_attachments", { entityType: "quote", entityId: 3 });
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/quotes/3/attachments/files/");
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
    const dir = await tmpDir("up-");
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

  it("maps public:true and folderId into the payload, omitting Folder when absent", async () => {
    const dir = await tmpDir("up-");
    const p = nodePath.join(dir, "a.txt");
    await fsp.writeFile(p, "x");
    const { ctx, spy } = makeCtx();
    await callTool(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: p }],
      public: true,
      folderId: 42,
    });
    const first = spy.posts[0].payload as Record<string, unknown>;
    expect(first.Public).toBe(true);
    expect(first.Folder).toBe(42);

    await callTool(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: p }],
    });
    const second = spy.posts[1].payload as Record<string, unknown>;
    expect("Folder" in second).toBe(false);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("uploads from a sourceUrl by fetching the bytes", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(Buffer.from("REMOTE"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })) as typeof fetch;
    try {
      const { ctx, spy } = makeCtx();
      const out = await callTool(ctx, "simpro_upload_attachment", {
        confirm: true,
        entityType: "job",
        entityId: 1,
        files: [{ sourceUrl: "https://files.example.com/a.pdf" }],
      });
      expect(spy.posts).toHaveLength(1);
      const payload = spy.posts[0].payload as Record<string, unknown>;
      expect(Buffer.from(payload.Base64Data as string, "base64").toString()).toBe("REMOTE");
      expect(out).toMatch(/1 uploaded, 0 failed/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("uploads a staged file by ref and clears the staging dir afterward", async () => {
    const staging = await tmpDir("stg-");
    const refDir = nodePath.join(staging, "ref123ABC");
    await fsp.mkdir(refDir, { recursive: true });
    await fsp.writeFile(nodePath.join(refDir, "docket.pdf"), "STAGED");
    const { ctx, spy } = makeCtx({ stagingDir: staging });
    await callTool(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ stagingRef: "ref123ABC" }],
    });
    expect(spy.posts).toHaveLength(1);
    const payload = spy.posts[0].payload as Record<string, unknown>;
    expect(payload.Filename).toBe("docket.pdf");
    expect(Buffer.from(payload.Base64Data as string, "base64").toString()).toBe("STAGED");
    // clearStaging removed the ref dir after success.
    await expect(fsp.readdir(refDir)).rejects.toBeTruthy();
    await fsp.rm(staging, { recursive: true, force: true });
  });

  it("disables filePath uploads on the shared HTTP server", async () => {
    const dir = await tmpDir("up-");
    const p = nodePath.join(dir, "secret.txt");
    await fsp.writeFile(p, "hi");
    const { ctx, spy } = makeCtx({ transport: "http" });
    const { text, isError } = await callToolRaw(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: p }],
    });
    expect(spy.posts).toHaveLength(0);
    expect(isError).toBe(true);
    expect(text).toMatch(/filePath uploads are disabled/i);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("continues a batch past one bad file and flags isError on partial failure", async () => {
    const dir = await tmpDir("up-");
    const good = nodePath.join(dir, "ok.txt");
    await fsp.writeFile(good, "ok");
    const { ctx, spy } = makeCtx();
    const { text, isError } = await callToolRaw(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: good }, { filePath: nodePath.join(dir, "missing.txt") }],
    });
    expect(spy.posts).toHaveLength(1); // only the good file POSTed
    expect(text).toMatch(/1 uploaded, 1 failed/);
    expect(isError).toBe(true);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("flags isError and POSTs nothing when every file in the batch fails", async () => {
    const { ctx, spy } = makeCtx();
    const { text, isError } = await callToolRaw(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: "/no/such/a.txt" }, { filePath: "/no/such/b.txt" }],
    });
    expect(spy.posts).toHaveLength(0);
    expect(text).toMatch(/0 uploaded, 2 failed/);
    expect(isError).toBe(true);
  });

  it("previews a malformed (zero/multi-source) batch without aborting", async () => {
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_upload_attachment", {
      confirm: false,
      entityType: "job",
      entityId: 1,
      files: [{}, { filePath: "/a", stagingRef: "b1c2d3e4" }],
    });
    expect(out).toMatch(/Confirmation required/i);
    expect(out).toMatch(/invalid/);
    expect(spy.posts).toHaveLength(0);
  });

  it("records malformed entries as per-file failures on execute (no batch abort)", async () => {
    const dir = await tmpDir("up-");
    const good = nodePath.join(dir, "ok.txt");
    await fsp.writeFile(good, "ok");
    const { ctx, spy } = makeCtx();
    const { text, isError } = await callToolRaw(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: good }, {}],
    });
    expect(spy.posts).toHaveLength(1);
    expect(text).toMatch(/1 uploaded, 1 failed/);
    expect(isError).toBe(true);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("rejects an over-limit file per-file while still uploading the small one", async () => {
    const dir = await tmpDir("up-");
    const small = nodePath.join(dir, "s.txt");
    await fsp.writeFile(small, "s");
    const big = nodePath.join(dir, "b.bin");
    await fsp.writeFile(big, Buffer.alloc(2 * 1024 * 1024));
    const { ctx, spy } = makeCtx({ maxMb: 1 });
    const { text } = await callToolRaw(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: small }, { filePath: big }],
    });
    expect(spy.posts).toHaveLength(1);
    expect(text).toMatch(/1 uploaded, 1 failed/);
    expect(text).toMatch(/over the .* MB limit/i);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe("simpro_download_attachment", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("requests the file with display=Base64 and returns metadata-only by default for non-images", async () => {
    const { ctx, spy } = makeCtx({ get: async () => fileRecord("report.pdf", "application/pdf", "PDF") });
    const { text, isError } = await callToolRaw(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5 }],
    });
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/jobs/1/attachments/files/5");
    expect(spy.gets[0].query).toEqual({ display: "Base64" });
    expect(text).toMatch(/metadata/i);
    expect(text).toContain("report.pdf");
    // metadata-only is NOT an error (boundary for the partial-failure rule).
    expect(isError).toBe(false);
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
    const dir = await tmpDir("dl-");
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

  it("auto-resolves an invoice to its linked Job for download", async () => {
    const { ctx, spy } = makeCtx({
      get: async (p: string) => {
        if (p.includes("/invoices/")) return { ID: 80, Jobs: { ID: 132277 } };
        return fileRecord("a.pdf", "application/pdf", "PDF");
      },
    });
    await callTool(ctx, "simpro_download_attachment", {
      entityType: "invoice",
      entityId: 80,
      files: [{ fileId: 5 }],
    });
    expect(spy.gets.some((g) => g.path.endsWith("/jobs/132277/attachments/files/5"))).toBe(true);
  });

  it("treats empty/missing Base64Data as a per-file error and writes no file", async () => {
    const dir = await tmpDir("dl-");
    const { ctx } = makeCtx({ get: async () => ({ Filename: "x.pdf", MimeType: "application/pdf" }) });
    const { text, isError } = await callToolRaw(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5 }],
      saveDir: dir,
    });
    expect(text).toMatch(/no file bytes/i);
    expect(isError).toBe(true);
    // No 0-byte file was written.
    await expect(fsp.readFile(nodePath.join(dir, "x.pdf"))).rejects.toBeTruthy();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("flags isError when the only file fails to download", async () => {
    const { ctx } = makeCtx({
      get: async () => {
        throw new Error("Simpro 500");
      },
    });
    const { isError } = await callToolRaw(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5 }],
    });
    expect(isError).toBe(true);
  });

  it("rejects an oversize image (no inline) and an oversize returnBase64 file", async () => {
    const bigB64 = Buffer.alloc(2 * 1024 * 1024).toString("base64");
    const { ctx } = makeCtx({
      maxMb: 1,
      get: async () => ({ Filename: "big.png", MimeType: "image/png", Base64Data: bigB64 }),
    });
    const img = await callToolRaw(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5 }],
    });
    expect(img.text).toMatch(/too large to inline/i);
    expect(img.text).not.toContain("[image]");
    expect(img.isError).toBe(true);

    const { ctx: ctx2 } = makeCtx({
      maxMb: 1,
      get: async () => ({ Filename: "big.bin", MimeType: "application/octet-stream", Base64Data: bigB64 }),
    });
    const raw = await callToolRaw(ctx2, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5 }],
      returnBase64: true,
    });
    expect(raw.text).toMatch(/too large to inline/i);
    expect(raw.isError).toBe(true);
  });

  it("inlines base64 for a normal non-image when returnBase64 is set", async () => {
    const { ctx } = makeCtx({ get: async () => fileRecord("data.bin", "application/octet-stream", "RAWBYTES") });
    const out = await callTool(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5 }],
      returnBase64: true,
    });
    expect(out).toMatch(/\(base64\)/);
    expect(out).toContain(Buffer.from("RAWBYTES").toString("base64"));
    expect(out).toMatch(/1 delivered/);
  });
});

describe("simpro_download_attachment path confinement (HTTP mode)", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("confines saves under SIMPRO_DOWNLOAD_DIR and rejects an absolute escape", async () => {
    const base = await tmpDir("dlbase-");
    const outside = await tmpDir("dlout-");
    const { ctx } = makeCtx({
      transport: "http",
      downloadDir: base,
      get: async () => fileRecord("a.pdf", "application/pdf", "PDF"),
    });
    const evil = nodePath.join(outside, "stolen.pdf");
    const escape = await callToolRaw(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5, savePath: evil }],
    });
    expect(escape.isError).toBe(true);
    expect(escape.text).toMatch(/outside the allowed directory/i);
    await expect(fsp.readFile(evil)).rejects.toBeTruthy();

    // A relative save lands inside the download dir.
    const ok = await callToolRaw(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 6, savePath: "inv/a.pdf" }],
    });
    expect(ok.text).toMatch(/saved/i);
    expect(await fsp.readFile(nodePath.join(base, "inv", "a.pdf"), "utf8")).toBe("PDF");

    await fsp.rm(base, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  });

  it("rejects a saveDir that escapes the download dir via '..'", async () => {
    const base = await tmpDir("dlbase-");
    const { ctx } = makeCtx({
      transport: "http",
      downloadDir: base,
      get: async () => fileRecord("a.pdf", "application/pdf", "PDF"),
    });
    const { isError, text } = await callToolRaw(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5 }],
      saveDir: nodePath.join(base, ".."),
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/outside the allowed directory/i);
    await fsp.rm(base, { recursive: true, force: true });
  });

  it("refuses to overwrite an existing file on the confined path", async () => {
    const base = await tmpDir("dlbase-");
    const { ctx } = makeCtx({
      transport: "http",
      downloadDir: base,
      get: async () => fileRecord("a.pdf", "application/pdf", "PDF"),
    });
    const first = await callToolRaw(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5, savePath: "a.pdf" }],
    });
    expect(first.text).toMatch(/saved/i);
    const second = await callToolRaw(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5, savePath: "a.pdf" }],
    });
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/already exists/i);
    await fsp.rm(base, { recursive: true, force: true });
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

  it("flags isError when one delete in the batch fails", async () => {
    const { ctx } = makeCtx({
      del: async (p: string) => {
        if (p.endsWith("/6")) throw new Error("Simpro 409");
        return {};
      },
    });
    const { text, isError } = await callToolRaw(ctx, "simpro_delete_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      fileIds: [5, 6],
    });
    expect(text).toMatch(/1 deleted, 1 failed/);
    expect(isError).toBe(true);
  });
});
