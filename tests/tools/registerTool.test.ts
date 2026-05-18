// tests/tools/registerTool.test.ts
//
// Proves the per-request schema memoisation is correct AND user-independent:
//   1. registerAllTools can run on two separate McpServer instances (two
//      different user ctxs) without error and exposes the same tool count
//      (no per-instance state corruption from sharing module-level schema).
//   2. The tool input JSON schemas are byte-for-byte identical across the two
//      registrations (schema does not depend on the per-user client/config).
//   3. Each tool's shape factory is invoked at most once across BOTH
//      registrations (the memo works; the cached shape is reused per request).

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/tools/index.js";
import {
  __schemaBuildCounts,
  __resetSchemaCacheForTests,
  type ToolCtx,
} from "../../src/tools/_shared.js";

// Minimal fake ctx — handlers are never invoked here (we only list tools), so
// these stubs are enough. Crucially the two ctxs are DIFFERENT objects, mimicking
// two different users hitting the stateless HTTP transport concurrently.
function fakeCtx(tag: string): ToolCtx {
  return {
    client: { tag, companyPath: (p: string) => p } as unknown as ToolCtx["client"],
    config: { SIMPRO_DEFAULT_PAGE_SIZE: 20, tag } as unknown as ToolCtx["config"],
  };
}

async function listTools(ctx: ToolCtx) {
  const server = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerAllTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

describe("registerTool memoisation (per-request HTTP transport safety)", () => {
  it("two registrations: same tool count, identical schemas, factory runs once", async () => {
    __resetSchemaCacheForTests();

    const toolsA = await listTools(fakeCtx("userA"));
    const buildsAfterFirst = new Map(__schemaBuildCounts);
    const toolsB = await listTools(fakeCtx("userB"));

    // 1. No error + same tool count across two separate McpServer instances.
    expect(toolsA.length).toBeGreaterThan(40);
    expect(toolsB.length).toBe(toolsA.length);

    // 2. Input schemas are user-independent: identical across both users.
    const byName = (ts: typeof toolsA) =>
      Object.fromEntries(ts.map((t) => [t.name, t.inputSchema]));
    expect(byName(toolsB)).toEqual(byName(toolsA));

    // 3. The shape factory ran AT MOST once per tool across BOTH registrations
    //    (the second registration reused the cached shape — no rebuild).
    for (const [, count] of buildsAfterFirst) {
      expect(count).toBe(1);
    }
    // No additional builds were recorded during the second registration.
    expect([...__schemaBuildCounts.entries()]).toEqual(
      [...buildsAfterFirst.entries()],
    );
    for (const [, count] of __schemaBuildCounts) {
      expect(count).toBe(1);
    }
  });
});
