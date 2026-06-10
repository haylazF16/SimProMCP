// tests/tools/costCentrePayload.test.ts
//
// Regression: pin the POST body for attaching a cost centre to a job section.
// Production evidence (journalctl Jun 8-10, 2026): every call to
// POST /jobs/{id}/sections/{sid}/costCenters/ failed 422 with
//   {"errors":[{"path":"/CostCentre","message":"Invalid column.","value":{"ID":130}}]}
// because the tools sent { CostCentre: { ID } }. Simpro's documented payload
// (apiforum.simprogroup.com t=1173, t=2832) is { CostCenter: <setupID> } —
// US spelling, bare ID. The tool had NEVER succeeded in production; the
// audit log masked this by recording ok:true (see auditOkFlag fix).

import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerJobTools } from "../../src/tools/jobs.js";
import {
  __resetSchemaCacheForTests,
  type ToolCtx,
} from "../../src/tools/_shared.js";

interface CapturedPost {
  path: string;
  payload: unknown;
}

function writeCtxWithSpy(): { ctx: ToolCtx; posts: CapturedPost[] } {
  const posts: CapturedPost[] = [];
  const ctx = {
    client: {
      companyPath: (p: string) => `/companies/0${p}`,
      get: async () => ({ data: [] }),
      post: async (path: string, payload: unknown) => {
        posts.push({ path, payload });
        return { ID: 777 };
      },
      patch: async () => {
        throw new Error("patch() not expected");
      },
    } as unknown as ToolCtx["client"],
    config: {
      SIMPRO_DEFAULT_PAGE_SIZE: 25,
      SIMPRO_ENABLE_WRITE_TOOLS: true,
      SIMPRO_DRY_RUN: false,
    } as unknown as ToolCtx["config"],
  };
  return { ctx, posts };
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
  registerJobTools(server, ctx);
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

describe("job section cost-centre POST payload (Simpro shape: { CostCenter: <id> })", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("simpro_add_section_cost_centre sends { CostCenter: <bare id> }", async () => {
    const { ctx, posts } = writeCtxWithSpy();
    await callTool(ctx, "simpro_add_section_cost_centre", {
      confirm: true,
      jobId: 132034,
      sectionId: 300971,
      costCentreId: 130,
    });
    const cc = posts.find((p) => p.path.includes("/costCenters/"));
    expect(cc, "expected a POST to .../costCenters/").toBeDefined();
    expect(cc!.payload).toEqual({ CostCenter: 130 });
    expect(cc!.payload).not.toHaveProperty("CostCentre");
  });

  it("simpro_add_job_section compound call sends { CostCenter: <bare id> } too", async () => {
    const { ctx, posts } = writeCtxWithSpy();
    await callTool(ctx, "simpro_add_job_section", {
      confirm: true,
      jobId: 132034,
      name: "Maintenance",
      costCenterId: 129,
    });
    // First POST creates the section, second attaches the cost centre.
    const cc = posts.find((p) => p.path.includes("/costCenters/"));
    expect(cc, "expected a follow-up POST to .../costCenters/").toBeDefined();
    expect(cc!.payload).toEqual({ CostCenter: 129 });
    expect(cc!.payload).not.toHaveProperty("CostCentre");
  });
});
