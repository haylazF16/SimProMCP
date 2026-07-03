import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolCtx } from "../../src/tools/_shared.js";
import { registerJobTools } from "../../src/tools/jobs.js";
import { registerTaskTools } from "../../src/tools/tasks.js";
import { registerSchedulingTools } from "../../src/tools/scheduling.js";
import { registerFinancialsTools } from "../../src/tools/financials.js";
import { registerCustomerTools } from "../../src/tools/customers.js";
import { registerSupplierTools } from "../../src/tools/suppliers.js";

type RegisterFn = (server: McpServer, ctx: ToolCtx) => void;

interface Spy { gets: { path: string; query?: unknown }[] }

function makeCtx(getResult: unknown = {}): { ctx: ToolCtx; spy: Spy } {
  const spy: Spy = { gets: [] };
  const ctx = {
    client: {
      companyPath: (p: string) => `/api/v1.0/companies/4${p}`,
      get: async (p: string, q?: unknown) => {
        spy.gets.push({ path: p, query: q });
        return getResult;
      },
      post: async () => ({}),
      patch: async () => ({}),
    } as unknown as ToolCtx["client"],
    config: {
      SIMPRO_ENABLE_WRITE_TOOLS: false,
      SIMPRO_DRY_RUN: false,
      SIMPRO_DEFAULT_PAGE_SIZE: 20,
      SIMPRO_MAX_PAGE_SIZE: 100,
    } as unknown as ToolCtx["config"],
  };
  return { ctx, spy };
}

async function callTool(
  register: RegisterFn,
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  register(server, ctx);
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

describe("job-internal reads", () => {
  it("simpro_list_job_notes GETs /jobs/{id}/notes/", async () => {
    const { ctx, spy } = makeCtx([{ ID: 1, Subject: "Called client" }]);
    const r = await callTool(registerJobTools, ctx, "simpro_list_job_notes", { jobId: 10 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/jobs/10/notes/");
  });

  it("simpro_get_job_note GETs /jobs/{id}/notes/{noteId}", async () => {
    const { ctx, spy } = makeCtx({ ID: 3, Subject: "Note" });
    const r = await callTool(registerJobTools, ctx, "simpro_get_job_note", { jobId: 10, noteId: 3 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/jobs/10/notes/3");
  });

  it("simpro_get_job_section GETs /jobs/{id}/sections/{sid}", async () => {
    const { ctx, spy } = makeCtx({ ID: 2, Name: "Section A" });
    const r = await callTool(registerJobTools, ctx, "simpro_get_job_section", { jobId: 10, sectionId: 2 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/jobs/10/sections/2");
  });

  it("simpro_list_section_cost_centres GETs the costCenters list", async () => {
    const { ctx, spy } = makeCtx([{ ID: 7, Name: "Plumbing" }]);
    const r = await callTool(registerJobTools, ctx, "simpro_list_section_cost_centres", { jobId: 10, sectionId: 2 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/jobs/10/sections/2/costCenters/");
  });

  it("simpro_get_section_cost_centre GETs one costCenter", async () => {
    const { ctx, spy } = makeCtx({ ID: 7, Name: "Plumbing" });
    const r = await callTool(registerJobTools, ctx, "simpro_get_section_cost_centre", { jobId: 10, sectionId: 2, costCentreId: 7 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/jobs/10/sections/2/costCenters/7");
  });
});

describe("tasks/staff/cost-centre reads", () => {
  it("simpro_list_tasks GETs /tasks/ with pagination", async () => {
    const { ctx, spy } = makeCtx([{ ID: 1, Subject: "Chase certificate" }]);
    const r = await callTool(registerTaskTools, ctx, "simpro_list_tasks", {});
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/tasks/");
    expect(spy.gets[0].query).toMatchObject({ page: 1 });
  });

  it("simpro_get_task GETs /tasks/{id}", async () => {
    const { ctx, spy } = makeCtx({ ID: 15, Subject: "Chase certificate" });
    const r = await callTool(registerTaskTools, ctx, "simpro_get_task", { taskId: 15 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/tasks/15");
  });

  it("simpro_get_staff_member GETs /staff/{id}", async () => {
    const { ctx, spy } = makeCtx({ ID: 3, Name: "Sinan" });
    const r = await callTool(registerTaskTools, ctx, "simpro_get_staff_member", { staffId: 3 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/staff/3");
  });

  it("simpro_get_cost_centre GETs /setup/accounts/costCenters/{id}", async () => {
    const { ctx, spy } = makeCtx({ ID: 12, Name: "Maintenance" });
    const r = await callTool(registerTaskTools, ctx, "simpro_get_cost_centre", { costCentreId: 12 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/setup/accounts/costCenters/12");
  });
});

describe("scheduling reads", () => {
  it("simpro_get_schedule GETs /schedules/{id}", async () => {
    const { ctx, spy } = makeCtx({ ID: 44, Type: "job" });
    const r = await callTool(registerSchedulingTools, ctx, "simpro_get_schedule", { scheduleId: 44 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/schedules/44");
  });

  it("simpro_get_timesheet GETs /timesheets/{uid}", async () => {
    const { ctx, spy } = makeCtx({ UID: "abc-1" });
    const r = await callTool(registerSchedulingTools, ctx, "simpro_get_timesheet", { timesheetUid: "abc-1" });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/timesheets/abc-1");
  });
});

describe("financial reads", () => {
  it("simpro_get_customer_payment GETs /customerPayments/{id}", async () => {
    const { ctx, spy } = makeCtx({ ID: 66 });
    const r = await callTool(registerFinancialsTools, ctx, "simpro_get_customer_payment", { paymentId: 66 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/customerPayments/66");
  });

  it("simpro_get_recurring_invoice GETs /recurringInvoices/{id}", async () => {
    const { ctx, spy } = makeCtx({ ID: 9 });
    const r = await callTool(registerFinancialsTools, ctx, "simpro_get_recurring_invoice", { recurringInvoiceId: 9 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/recurringInvoices/9");
  });
});
