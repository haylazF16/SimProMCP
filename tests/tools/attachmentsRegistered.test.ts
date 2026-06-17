import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/tools/index.js";
import { __resetSchemaCacheForTests, type ToolCtx } from "../../src/tools/_shared.js";

describe("registerAllTools wires the attachment tools", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("exposes the four attachment tools", async () => {
    const ctx = {
      client: { companyPath: (p: string) => p, get: async () => [], post: async () => ({}), del: async () => ({}) },
      config: { SIMPRO_ENABLE_WRITE_TOOLS: false, SIMPRO_DRY_RUN: true, SIMPRO_DEFAULT_PAGE_SIZE: 25 },
    } as unknown as ToolCtx;
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    registerAllTools(server, ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("simpro_list_attachments");
      expect(names).toContain("simpro_upload_attachment");
      expect(names).toContain("simpro_download_attachment");
      expect(names).toContain("simpro_delete_attachment");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
