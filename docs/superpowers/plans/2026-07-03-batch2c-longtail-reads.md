# Batch 2c: Long-Tail Reads + Final Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 17 read tools covering every remaining non-delete/non-financial-write endpoint, then run the batch-wide end-to-end verification the user required ("test all the work at the end").

**Architecture:** Read tools clone `simpro_get_supplier` (single record) and `simpro_search_suppliers` (list) from `src/tools/suppliers.ts`. New endpoint helpers are added once in `src/simpro/endpoints.ts` (Task 1); tools distribute into the domain file that already owns their resource. One shared test file with a spy-client harness (clone of `tests/tools/crmWrites.test.ts`, parameterised by register function).

**Tech Stack:** TypeScript strict, Zod, MCP SDK, Vitest, MCP Inspector (live smoke).

**Spec:** `docs/superpowers/specs/2026-07-03-gap-fill-batch2-nonfinancial-sweep-design.md`
**Branch:** `feat/http-transport`
**Prereq:** Batches 2a + 2b committed.

**Tool → file map (17 tools):**

| File (existing register fn) | New tools |
|---|---|
| `jobs.ts` (`registerJobTools`) | `simpro_list_job_notes`, `simpro_get_job_note`, `simpro_get_job_section`, `simpro_list_section_cost_centres`, `simpro_get_section_cost_centre` |
| `tasks.ts` (`registerTaskTools`) | `simpro_list_tasks`, `simpro_get_task`, `simpro_get_staff_member`, `simpro_get_cost_centre` |
| `scheduling.ts` (`registerSchedulingTools`) | `simpro_get_schedule`, `simpro_get_timesheet` |
| `financials.ts` (`registerFinancialsTools`) | `simpro_get_customer_payment`, `simpro_get_recurring_invoice` |
| `customers.ts` (`registerCustomerTools`) | `simpro_list_customer_companies`, `simpro_list_customer_individuals` |
| `suppliers.ts` (`registerSupplierTools`) | `simpro_list_po_receipts`, `simpro_get_receipt_catalog` |

---

### Task 1: Endpoint helpers

**Files:**
- Modify: `src/simpro/endpoints.ts` (extend the `ENDPOINTS` object)

- [ ] **Step 1: Add the new path helpers**

Inside `ENDPOINTS` in `src/simpro/endpoints.ts`, add (keep each near its resource group):

```typescript
  // (near jobNotes)
  jobNoteById: (jobId: string | number, noteId: string | number) =>
    `/jobs/${encodeURIComponent(String(jobId))}/notes/${encodeURIComponent(String(noteId))}`,
  jobSectionCostCenterById: (jobId: string | number, sectionId: string | number, ccId: string | number) =>
    `/jobs/${encodeURIComponent(String(jobId))}/sections/${encodeURIComponent(String(sectionId))}/costCenters/${encodeURIComponent(String(ccId))}`,

  // (near vendorReceipts)
  vendorOrderReceipts: (orderId: string | number) =>
    `/vendorOrders/${encodeURIComponent(String(orderId))}/receipts/`,
  vendorReceiptCatalogById: (orderId: string | number, receiptId: string | number, catalogId: string | number) =>
    `/vendorOrders/${encodeURIComponent(String(orderId))}/receipts/${encodeURIComponent(String(receiptId))}/catalogs/${encodeURIComponent(String(catalogId))}`,

  // (near schedules/timesheets)
  scheduleById: (id: string | number) => `/schedules/${encodeURIComponent(String(id))}`,
  timesheetByUid: (uid: string) => `/timesheets/${encodeURIComponent(uid)}`,

  // (near customerPayments / recurringInvoices)
  customerPaymentById: (id: string | number) => `/customerPayments/${encodeURIComponent(String(id))}`,
  recurringInvoiceById: (id: string | number) => `/recurringInvoices/${encodeURIComponent(String(id))}`,

  // (near staff / costCentres)
  staffById: (id: string | number) => `/staff/${encodeURIComponent(String(id))}`,
  costCentreById: (id: string | number) => `/setup/accounts/costCenters/${encodeURIComponent(String(id))}`,
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/simpro/endpoints.ts
git commit -m "feat(endpoints): path helpers for batch-2c long-tail reads"
```

---

### Task 2: Job-internal reads (5 tools)

**Files:**
- Modify: `src/tools/jobs.ts` (end of `registerJobTools`)
- Test: `tests/tools/longtailReads.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/longtailReads.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/longtailReads.test.ts`
Expected: 5 FAIL (tool not found).

- [ ] **Step 3: Implement the five tools**

At the end of `registerJobTools` in `src/tools/jobs.ts` (all imports already present in that file):

```typescript
  // ---- list job notes ----
  registerTool(
    server,
    "simpro_list_job_notes",
    "List the notes on a Simpro job (newest first as returned by Simpro). Use simpro_get_job_note for one note's full detail.",
    () => ({ jobId: idSchema, page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(1000).optional(), raw: rawFlagSchema }),
    () => async ({ jobId, page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.jobNotes(jobId));
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, { ...pg.query });
        const items = extractList(resp) as { ID?: number; Subject?: string; DateIssued?: string }[];
        return formatList(items, undefined, pg.page, pg.pageSize,
          (n) => `#${n.ID ?? "?"} ${n.Subject ?? "(no subject)"}${n.DateIssued ? ` — ${n.DateIssued}` : ""}`,
          resp, raw === true);
      }),
  );

  // ---- get job note ----
  registerTool(
    server,
    "simpro_get_job_note",
    "Get one Simpro job note by ID, including its full text.",
    () => ({ jobId: idSchema, noteId: idSchema, raw: rawFlagSchema }),
    () => async ({ jobId, noteId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.jobNoteById(jobId, noteId));
        const resp = await ctx.client.get<{ ID?: number; Subject?: string }>(path);
        return formatRecord(`Job #${jobId} note #${resp.ID ?? noteId}: ${resp.Subject ?? ""}`, resp, resp, raw === true);
      }),
  );

  // ---- get job section ----
  registerTool(
    server,
    "simpro_get_job_section",
    "Get one Simpro job section by ID (name, display order). Use simpro_list_job_sections to find section IDs.",
    () => ({ jobId: idSchema, sectionId: idSchema, raw: rawFlagSchema }),
    () => async ({ jobId, sectionId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.jobSectionById(jobId, sectionId));
        const resp = await ctx.client.get<{ ID?: number; Name?: string }>(path);
        return formatRecord(`Job #${jobId} section #${resp.ID ?? sectionId}: ${resp.Name ?? "(unnamed)"}`, resp, resp, raw === true);
      }),
  );

  // ---- list section cost centres ----
  registerTool(
    server,
    "simpro_list_section_cost_centres",
    "List the cost centres (line items) attached to one job section.",
    () => ({ jobId: idSchema, sectionId: idSchema, raw: rawFlagSchema }),
    () => async ({ jobId, sectionId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.jobSectionCostCenters(jobId, sectionId));
        const resp = await ctx.client.get<unknown>(path);
        const items = extractList(resp) as { ID?: number; Name?: string }[];
        return formatList(items, undefined, 1, items.length || 1,
          (c) => `#${c.ID ?? "?"} ${c.Name ?? "(unnamed)"}`, resp, raw === true);
      }),
  );

  // ---- get section cost centre ----
  registerTool(
    server,
    "simpro_get_section_cost_centre",
    "Get one cost centre (line item) on a job section, including totals and claim fields.",
    () => ({ jobId: idSchema, sectionId: idSchema, costCentreId: idSchema, raw: rawFlagSchema }),
    () => async ({ jobId, sectionId, costCentreId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.jobSectionCostCenterById(jobId, sectionId, costCentreId));
        const resp = await ctx.client.get<{ ID?: number; Name?: string }>(path);
        return formatRecord(`Section cost centre #${resp.ID ?? costCentreId}: ${resp.Name ?? "(unnamed)"}`, resp, resp, raw === true);
      }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/longtailReads.test.ts`
Expected: PASS (5).

- [ ] **Step 5: Commit**

```bash
git add src/tools/jobs.ts tests/tools/longtailReads.test.ts
git commit -m "feat(jobs): 5 long-tail read tools (notes, section, section cost centres)"
```

---

### Task 3: Tasks/staff/cost-centre reads (4 tools)

**Files:**
- Modify: `src/tools/tasks.ts` (end of `registerTaskTools`)
- Test: `tests/tools/longtailReads.test.ts` (extend)

Note: `simpro_get_task` does NOT exist yet (verified 2026-07-03: `grep -rn "simpro_get_task" src/` → no hits; only `simpro_update_task` uses `ENDPOINTS.taskById`). It is added here.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools/longtailReads.test.ts`:

```typescript
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
    const { ctx, spy } = makeCtx({ ID: 3, GivenName: "Sinan", FamilyName: "K" });
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/longtailReads.test.ts`
Expected: 4 new FAIL.

- [ ] **Step 3: Implement**

At the end of `registerTaskTools` in `src/tools/tasks.ts` (check imports: needs `paginationQuery`, `extractList`, `formatList`, `formatRecord`, `idSchema`, `rawFlagSchema`, `z` — add any missing):

```typescript
  // ---- get task ----
  registerTool(
    server,
    "simpro_get_task",
    "Get one Simpro task by ID (subject, assignee, due date, status). Use simpro_list_tasks to find IDs.",
    () => ({ taskId: idSchema, raw: rawFlagSchema }),
    () => async ({ taskId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.taskById(taskId));
        const resp = await ctx.client.get<{ ID?: number; Subject?: string }>(path);
        return formatRecord(`Task #${resp.ID ?? taskId}: ${resp.Subject ?? "(no subject)"}`, resp, resp, raw === true);
      }),
  );

  // ---- list tasks ----
  registerTool(
    server,
    "simpro_list_tasks",
    "List Simpro tasks (paginated). Use simpro_get_task for one task's full detail.",
    () => ({ page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(1000).optional(), raw: rawFlagSchema }),
    () => async ({ page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.tasks);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, { ...pg.query });
        const items = extractList(resp) as { ID?: number; Subject?: string }[];
        return formatList(items, undefined, pg.page, pg.pageSize,
          (t) => `#${t.ID ?? "?"} ${t.Subject ?? "(no subject)"}`, resp, raw === true);
      }),
  );

  // ---- get staff member ----
  registerTool(
    server,
    "simpro_get_staff_member",
    "Get one Simpro staff member by ID (name, type). Use simpro_list_staff to find IDs.",
    () => ({ staffId: idSchema, raw: rawFlagSchema }),
    () => async ({ staffId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.staffById(staffId));
        const resp = await ctx.client.get<{ ID?: number; GivenName?: string; FamilyName?: string }>(path);
        const name = [resp.GivenName, resp.FamilyName].filter(Boolean).join(" ") || "(unnamed)";
        return formatRecord(`Staff #${resp.ID ?? staffId}: ${name}`, resp, resp, raw === true);
      }),
  );

  // ---- get cost centre ----
  registerTool(
    server,
    "simpro_get_cost_centre",
    "Get one Simpro cost centre (setup) by ID. Use simpro_list_cost_centres to find IDs.",
    () => ({ costCentreId: idSchema, raw: rawFlagSchema }),
    () => async ({ costCentreId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.costCentreById(costCentreId));
        const resp = await ctx.client.get<{ ID?: number; Name?: string }>(path);
        return formatRecord(`Cost centre #${resp.ID ?? costCentreId}: ${resp.Name ?? "(unnamed)"}`, resp, resp, raw === true);
      }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/longtailReads.test.ts`
Expected: PASS (9).

- [ ] **Step 5: Commit**

```bash
git add src/tools/tasks.ts tests/tools/longtailReads.test.ts
git commit -m "feat(tasks): get/list tasks + get staff member + get cost centre reads"
```

---

### Task 4: Scheduling reads (2 tools)

**Files:**
- Modify: `src/tools/scheduling.ts` (end of `registerSchedulingTools`)
- Test: `tests/tools/longtailReads.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run tests/tools/longtailReads.test.ts`

- [ ] **Step 3: Implement**

At the end of `registerSchedulingTools` in `src/tools/scheduling.ts` (add missing imports as in Task 3):

```typescript
  // ---- get schedule ----
  registerTool(
    server,
    "simpro_get_schedule",
    "Get one Simpro schedule entry by ID (staff, blocks, date). Use simpro_search_schedules to find IDs.",
    () => ({ scheduleId: idSchema, raw: rawFlagSchema }),
    () => async ({ scheduleId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.scheduleById(scheduleId));
        const resp = await ctx.client.get<{ ID?: number }>(path);
        return formatRecord(`Schedule #${resp.ID ?? scheduleId}`, resp, resp, raw === true);
      }),
  );

  // ---- get timesheet ----
  registerTool(
    server,
    "simpro_get_timesheet",
    "Get one Simpro timesheet entry by its UID (from simpro_search_timesheets).",
    () => ({ timesheetUid: z.string().min(1).describe("Timesheet UID from search results."), raw: rawFlagSchema }),
    () => async ({ timesheetUid, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.timesheetByUid(timesheetUid));
        const resp = await ctx.client.get<Record<string, unknown>>(path);
        return formatRecord(`Timesheet ${timesheetUid}`, resp, resp, raw === true);
      }),
  );
```

- [ ] **Step 4: Run to verify PASS (11)** — `npx vitest run tests/tools/longtailReads.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/tools/scheduling.ts tests/tools/longtailReads.test.ts
git commit -m "feat(scheduling): get schedule + get timesheet reads"
```

---

### Task 5: Financial reads (2 tools)

**Files:**
- Modify: `src/tools/financials.ts` (end of `registerFinancialsTools`)
- Test: `tests/tools/longtailReads.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** (end of `registerFinancialsTools`; imports as before):

```typescript
  // ---- get customer payment ----
  registerTool(
    server,
    "simpro_get_customer_payment",
    "Get one customer payment record by ID (read-only). Use simpro_search_customer_payments to find IDs.",
    () => ({ paymentId: idSchema, raw: rawFlagSchema }),
    () => async ({ paymentId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.customerPaymentById(paymentId));
        const resp = await ctx.client.get<{ ID?: number }>(path);
        return formatRecord(`Customer payment #${resp.ID ?? paymentId}`, resp, resp, raw === true);
      }),
  );

  // ---- get recurring invoice ----
  registerTool(
    server,
    "simpro_get_recurring_invoice",
    "Get one recurring invoice template by ID (read-only). Use simpro_search_recurring_invoices to find IDs.",
    () => ({ recurringInvoiceId: idSchema, raw: rawFlagSchema }),
    () => async ({ recurringInvoiceId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.recurringInvoiceById(recurringInvoiceId));
        const resp = await ctx.client.get<{ ID?: number }>(path);
        return formatRecord(`Recurring invoice #${resp.ID ?? recurringInvoiceId}`, resp, resp, raw === true);
      }),
  );
```

- [ ] **Step 4: Run to verify PASS (13).**

- [ ] **Step 5: Commit**

```bash
git add src/tools/financials.ts tests/tools/longtailReads.test.ts
git commit -m "feat(financials): get customer payment + get recurring invoice reads"
```

---

### Task 6: Typed customer lists (2 tools)

**Files:**
- Modify: `src/tools/customers.ts` (end of `registerCustomerTools`)
- Test: `tests/tools/longtailReads.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

```typescript
describe("typed customer lists", () => {
  it("simpro_list_customer_companies GETs /customers/companies/", async () => {
    const { ctx, spy } = makeCtx([{ ID: 1, CompanyName: "Acme" }]);
    const r = await callTool(registerCustomerTools, ctx, "simpro_list_customer_companies", {});
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/customers/companies/");
  });

  it("simpro_list_customer_individuals GETs /customers/individuals/", async () => {
    const { ctx, spy } = makeCtx([{ ID: 2, GivenName: "Jo" }]);
    const r = await callTool(registerCustomerTools, ctx, "simpro_list_customer_individuals", {});
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/customers/individuals/");
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** (end of `registerCustomerTools`; `ENDPOINTS.customersCompanies` / `customersIndividuals` already exist):

```typescript
  // ---- list company customers ----
  registerTool(
    server,
    "simpro_list_customer_companies",
    "List company-type customers only (paginated). simpro_search_customers returns both types mixed; use this when you specifically need companies.",
    () => ({ page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(1000).optional(), raw: rawFlagSchema }),
    () => async ({ page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.customersCompanies);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, { ...pg.query, columns: "ID,CompanyName,Email,Phone" });
        const items = extractList(resp) as { ID?: number; CompanyName?: string }[];
        return formatList(items, undefined, pg.page, pg.pageSize,
          (c) => `#${c.ID ?? "?"} ${c.CompanyName ?? "(unnamed)"}`, resp, raw === true);
      }),
  );

  // ---- list individual customers ----
  registerTool(
    server,
    "simpro_list_customer_individuals",
    "List individual-type customers only (paginated). simpro_search_customers returns both types mixed; use this when you specifically need individuals.",
    () => ({ page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(1000).optional(), raw: rawFlagSchema }),
    () => async ({ page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.customersIndividuals);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, { ...pg.query, columns: "ID,GivenName,FamilyName,Email,Phone" });
        const items = extractList(resp) as { ID?: number; GivenName?: string; FamilyName?: string }[];
        return formatList(items, undefined, pg.page, pg.pageSize,
          (c) => `#${c.ID ?? "?"} ${[c.GivenName, c.FamilyName].filter(Boolean).join(" ") || "(unnamed)"}`, resp, raw === true);
      }),
  );
```

- [ ] **Step 4: Run to verify PASS (15).**

- [ ] **Step 5: Commit**

```bash
git add src/tools/customers.ts tests/tools/longtailReads.test.ts
git commit -m "feat(customers): typed company/individual list reads"
```

---

### Task 7: PO receipt reads (2 tools)

**Files:**
- Modify: `src/tools/suppliers.ts` (end of `registerSupplierTools`)
- Test: `tests/tools/longtailReads.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

```typescript
describe("PO receipt reads", () => {
  it("simpro_list_po_receipts GETs /vendorOrders/{id}/receipts/", async () => {
    const { ctx, spy } = makeCtx([{ ID: 5, VendorInvoiceNo: "INV-9" }]);
    const r = await callTool(registerSupplierTools, ctx, "simpro_list_po_receipts", { purchaseOrderId: 30 });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/vendorOrders/30/receipts/");
  });

  it("simpro_get_receipt_catalog GETs one receipt catalog line", async () => {
    const { ctx, spy } = makeCtx({ ID: 12 });
    const r = await callTool(registerSupplierTools, ctx, "simpro_get_receipt_catalog", {
      purchaseOrderId: 30, receiptId: 5, catalogId: 12,
    });
    expect(r.isError).toBe(false);
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/vendorOrders/30/receipts/5/catalogs/12");
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** (end of `registerSupplierTools`):

```typescript
  // ---- list PO receipts ----
  registerTool(
    server,
    "simpro_list_po_receipts",
    "List the receipts (supplier invoices) recorded against one purchase order.",
    () => ({ purchaseOrderId: idSchema, raw: rawFlagSchema }),
    () => async ({ purchaseOrderId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.vendorOrderReceipts(purchaseOrderId));
        const resp = await ctx.client.get<unknown>(path);
        const items = extractList(resp) as SimproVendorReceipt[];
        return formatList(items, undefined, 1, items.length || 1,
          (r0) => `#${r0.ID ?? "?"} ${r0.VendorInvoiceNo ?? "(no invoice no)"}${r0.DateIssued ? ` — ${r0.DateIssued}` : ""}`,
          resp, raw === true);
      }),
  );

  // ---- get receipt catalog line ----
  registerTool(
    server,
    "simpro_get_receipt_catalog",
    "Get one catalog line item on a PO receipt (supplier invoice).",
    () => ({ purchaseOrderId: idSchema, receiptId: idSchema, catalogId: idSchema, raw: rawFlagSchema }),
    () => async ({ purchaseOrderId, receiptId, catalogId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.vendorReceiptCatalogById(purchaseOrderId, receiptId, catalogId));
        const resp = await ctx.client.get<{ ID?: number }>(path);
        return formatRecord(`Receipt catalog line #${resp.ID ?? catalogId}`, resp, resp, raw === true);
      }),
  );
```

- [ ] **Step 4: Run to verify PASS (17).**

- [ ] **Step 5: Full suite + commit**

Run: `npm run build && npx vitest run`
Expected: clean + all green.

```bash
git add src/tools/suppliers.ts tests/tools/longtailReads.test.ts
git commit -m "feat(suppliers): PO receipt list + receipt catalog line reads"
```

---

### Task 8: Final end-to-end verification (user requirement: "test all the work at the end")

**Files:**
- Create: `docs/superpowers/verification/2026-07-XX-batch2.md` (fill XX with actual date)
- Modify: `docs/SIMPRO_API_AUDIT.md`

- [ ] **Step 1: Full build + suite**

Run: `npm run build && npx vitest run`
Expected: build clean; ALL tests green (≈245 + ~40 new). Record counts.

- [ ] **Step 2: Launch the Inspector rig**

Use the established space-free launcher (see memory: Inspector v0.22 splits args on spaces; launcher lives at a space-free path, e.g. `C:\Users\tayfu\AppData\Local\Temp\mcp-insp\`). Copy fresh `dist/` there, set env: real `SIMPRO_BASE_URL`/`SIMPRO_API_KEY`/`SIMPRO_COMPANY_ID=4`, `SIMPRO_ENABLE_WRITE_TOOLS=true`, `SIMPRO_DRY_RUN=true`.

- [ ] **Step 3: Live smoke — every new READ tool, real calls (company 4 = Plumbing)**

Call each with a real ID discovered via the existing search tools first. Checklist (tick + note result in the verification doc):
`list_job_notes`, `get_job_note`, `get_job_section`, `list_section_cost_centres`, `get_section_cost_centre`, `list_tasks`, `get_task`, `get_staff_member`, `get_cost_centre`, `get_schedule`, `get_timesheet`, `get_customer_payment`, `get_recurring_invoice`, `list_customer_companies`, `list_customer_individuals`, `list_po_receipts`, `get_receipt_catalog`.
Expected: real data or a clean Simpro 404 for genuinely-empty resources — no tool crashes, no schema errors. If a tenant returns 404 on a path (e.g. timesheets by UID shape differs), fix the endpoint helper and re-run.

- [ ] **Step 4: Live smoke — every new WRITE tool in DRY-RUN**

With `SIMPRO_DRY_RUN=true`, call all 9 writes (`create/update_contact`, `create/update_lead`, `create/update_storage_device`, `create/update_stock_take`, `update_catalog_item`) with plausible args and `confirm:true`.
Expected: every one returns "DRY RUN — no request was sent", payload echo looks correct (PascalCase Simpro fields). ZERO real mutations.

- [ ] **Step 5: Spot-check company 37 (Energy)**

Re-run 3 reads (`list_tasks`, `list_customer_companies`, `get_staff_member`) with `SIMPRO_COMPANY_ID=37`.
Expected: same behavior against the Energy company.

- [ ] **Step 6: Write the verification doc**

Create `docs/superpowers/verification/2026-07-XX-batch2.md` with: date, dist build hash (`git rev-parse --short HEAD`), test counts, the read checklist results, the write dry-run checklist results, company-37 spot checks, and any endpoint fixes made during smoke.

- [ ] **Step 7: Update the audit doc**

In `docs/SIMPRO_API_AUDIT.md`: mark the 26 new endpoints covered, fix the 3 stale Batch-1 rows (`PATCH /jobs/{id}/sections/{id}`, `PATCH /vendorOrders/{id}`, `PATCH .../catalogs/{id}` → covered), and update the summary block (should land ~93/132 ≈ 70%; remaining gaps only deletes + financial writes + workforce writes).

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/verification/ docs/SIMPRO_API_AUDIT.md
git commit -m "test(batch2): end-to-end verification — live read smoke + write dry-runs; audit updated"
```

- [ ] **Step 9: STOP — report to the user**

Present the verification doc summary. **Do NOT push to GitHub, do NOT deploy to the Ubuntu box or production** until the user explicitly approves.

---

## Done criteria (2c + batch-wide)

- 17 new read tools; full suite green; build clean.
- Verification doc committed with every new tool smoke-tested (reads live, writes dry-run, both companies sampled).
- Audit doc updated to ~70% coverage with only deliberate gaps remaining.
- Work is committed locally only — push/deploy awaits user approval.
