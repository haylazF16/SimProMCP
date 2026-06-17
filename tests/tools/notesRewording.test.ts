import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerNoteTools } from "../../src/tools/notes.js";
import { __resetSchemaCacheForTests, type ToolCtx } from "../../src/tools/_shared.js";

describe("simpro_attach_file_link_to_job description no longer claims attachments are unsupported", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("recommends simpro_upload_attachment and drops the 'does not support' wording", async () => {
    const ctx = {
      client: { companyPath: (p: string) => p, post: async () => ({ ID: 1 }) },
      config: { SIMPRO_ENABLE_WRITE_TOOLS: false, SIMPRO_DRY_RUN: true },
    } as unknown as ToolCtx;
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    registerNoteTools(server, ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      const linkTool = tools.find((t) => t.name === "simpro_attach_file_link_to_job")!;
      expect(linkTool.description).toMatch(/simpro_upload_attachment/);
      expect(linkTool.description ?? "").not.toMatch(/doesn't support binary|does NOT support|missing attachment API/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
