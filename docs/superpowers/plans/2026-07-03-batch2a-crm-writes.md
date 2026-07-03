# Batch 2a: CRM Writes (Contacts + Leads) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 write tools — `simpro_create_contact`, `simpro_update_contact`, `simpro_create_lead`, `simpro_update_lead` — closing the last H-priority API gaps.

**Architecture:** Pure pattern-clone of existing write tools (see `simpro_create_supplier` in `src/tools/suppliers.ts`). Tools are added inside the existing `registerContactTools` in `src/tools/contacts.ts`; registration is already wired via `registerAllTools`. Writes go through `writeGuard` (env flag + confirm + dry-run) with `rawPayload` escape hatch.

**Tech Stack:** TypeScript strict, Zod, MCP SDK, Vitest (mocked client via `InMemoryTransport` harness).

**Spec:** `docs/superpowers/specs/2026-07-03-gap-fill-batch2-nonfinancial-sweep-design.md`
**Branch:** `feat/http-transport` (work directly on it; no new branch)
**Working dir:** repo root `ClaudeDevelopment/`

---

### Task 1: Contact write tools (`simpro_create_contact`, `simpro_update_contact`)

**Files:**
- Modify: `src/tools/contacts.ts` (add two tools at the end of `registerContactTools`, before the closing `}`)
- Test: `tests/tools/crmWrites.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/crmWrites.test.ts`:

```typescript
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
    const r = await callTool(ctx, "simpro_update_contact", { confirm: true, contactId: 321, email: "a@b.c" });
    expect(spy.patches).toHaveLength(0);
    expect(r.text).toContain("Write tools are disabled");
  });

  it("dry-run echoes without sending", async () => {
    const { ctx, spy } = makeCtx({ dryRun: true });
    const r = await callTool(ctx, "simpro_update_contact", { confirm: true, contactId: 321, email: "a@b.c" });
    expect(spy.patches).toHaveLength(0);
    expect(r.text).toContain("DRY RUN");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/crmWrites.test.ts`
Expected: FAIL — `callTool` errors with "Tool simpro_create_contact not found" (or MCP `-32602`).

- [ ] **Step 3: Implement the two contact tools**

In `src/tools/contacts.ts`:

(a) Extend the imports from `./_shared.js` to include `writeGuard` (already exports it), and from `../utils/schemas.js` add `confirmSchema, rawPayloadSchema`. Add `pruneEmpty`:

```typescript
import { idSchema, rawFlagSchema, confirmSchema, rawPayloadSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
// and add writeGuard to the existing ./_shared.js import list
```

(b) At the end of `registerContactTools` (before its closing `}`), add:

```typescript
  // ---- create contact ----
  registerTool(
    server,
    "simpro_create_contact",
    "Create a new contact (person attached to customers/sites) in Simpro. Requires confirm=true. Honors SIMPRO_ENABLE_WRITE_TOOLS and SIMPRO_DRY_RUN.",
    () => (
    {
      confirm: confirmSchema,
      givenName: z.string().min(1).describe("First name."),
      familyName: z.string().optional().describe("Last name."),
      email: z.string().email().optional(),
      workPhone: z.string().optional(),
      cellPhone: z.string().optional().describe("Mobile number."),
      position: z.string().optional().describe("Job title / role."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          GivenName: args.givenName,
          FamilyName: args.familyName,
          Email: args.email,
          WorkPhone: args.workPhone,
          CellPhone: args.cellPhone,
          Position: args.position,
        });
        const path = ctx.client.companyPath(ENDPOINTS.contacts);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create contact "${[args.givenName, args.familyName].filter(Boolean).join(" ")}" in Simpro`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<SimproContact>(path, payload);
        return formatRecord(`Created contact #${resp.ID ?? "?"}.`, resp, resp, true);
      }),
  );

  // ---- update contact ----
  registerTool(
    server,
    "simpro_update_contact",
    "Update an existing Simpro contact (partial update — only provided fields change). Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      contactId: idSchema,
      givenName: z.string().optional(),
      familyName: z.string().optional(),
      email: z.string().email().optional(),
      workPhone: z.string().optional(),
      cellPhone: z.string().optional(),
      position: z.string().optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          GivenName: args.givenName,
          FamilyName: args.familyName,
          Email: args.email,
          WorkPhone: args.workPhone,
          CellPhone: args.cellPhone,
          Position: args.position,
        });
        if (Object.keys(payload).length === 0) {
          return textResponse("No fields to update — provide at least one field or rawPayload.", true);
        }
        const path = ctx.client.companyPath(ENDPOINTS.contactById(args.contactId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update contact #${args.contactId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<SimproContact>(path, payload);
        return formatRecord(`Updated contact #${args.contactId}.`, resp, resp, true);
      }),
  );
```


- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/crmWrites.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run build && npx vitest run`
Expected: build clean; all suites green (existing 245 + 7).

- [ ] **Step 6: Commit**

```bash
git add src/tools/contacts.ts tests/tools/crmWrites.test.ts
git commit -m "feat(contacts): create + update contact write tools (H-priority gap)"
```

---

### Task 2: Lead write tools (`simpro_create_lead`, `simpro_update_lead`)

**Files:**
- Modify: `src/tools/contacts.ts` (leads already live here — `simpro_search_leads`, `simpro_get_lead`)
- Test: `tests/tools/crmWrites.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools/crmWrites.test.ts`:

```typescript
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
      Description: "New bathroom fit-out", Customer: { ID: 55 }, Site: { ID: 9 }, Salesperson: { ID: 3 },
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
    expect(spy.patches[0].payload).toEqual({ Description: "Renamed lead" });
  });

  it("rejects an empty update", async () => {
    const { ctx } = makeCtx();
    const r = await callTool(ctx, "simpro_update_lead", { confirm: true, leadId: 77 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No fields to update");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/crmWrites.test.ts`
Expected: the 4 new tests FAIL (tool not found); the 9 contact tests still PASS.

- [ ] **Step 3: Implement the two lead tools**

At the end of `registerContactTools` in `src/tools/contacts.ts`, after the contact write tools, add:

```typescript
  // ---- create lead ----
  registerTool(
    server,
    "simpro_create_lead",
    "Create a new sales lead in Simpro. Requires confirm=true. Look up IDs first: customer via simpro_search_customers, site via simpro_search_sites, salesperson via simpro_list_staff. Tenant-specific required fields can be supplied with rawPayload.",
    () => (
    {
      confirm: confirmSchema,
      leadName: z.string().min(1).describe("Short name/description of the lead (Simpro field: Description)."),
      customerId: idSchema.optional().describe("Simpro customer ID."),
      siteId: idSchema.optional().describe("Simpro site ID."),
      salespersonId: idSchema.optional().describe("Staff ID of the salesperson."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Description: args.leadName,
          Customer: args.customerId != null ? { ID: args.customerId } : undefined,
          Site: args.siteId != null ? { ID: args.siteId } : undefined,
          Salesperson: args.salespersonId != null ? { ID: args.salespersonId } : undefined,
        });
        const path = ctx.client.companyPath(ENDPOINTS.leads);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create lead "${args.leadName}" in Simpro`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<SimproLead>(path, payload);
        return formatRecord(`Created lead #${resp.ID ?? "?"}.`, resp, resp, true);
      }),
  );

  // ---- update lead ----
  registerTool(
    server,
    "simpro_update_lead",
    "Update an existing Simpro lead (partial update — only provided fields change). Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      leadId: idSchema,
      leadName: z.string().optional(),
      customerId: idSchema.optional(),
      siteId: idSchema.optional(),
      salespersonId: idSchema.optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Description: args.leadName,
          Customer: args.customerId != null ? { ID: args.customerId } : undefined,
          Site: args.siteId != null ? { ID: args.siteId } : undefined,
          Salesperson: args.salespersonId != null ? { ID: args.salespersonId } : undefined,
        });
        if (Object.keys(payload).length === 0) {
          return textResponse("No fields to update — provide at least one field or rawPayload.", true);
        }
        const path = ctx.client.companyPath(ENDPOINTS.leadById(args.leadId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update lead #${args.leadId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<SimproLead>(path, payload);
        return formatRecord(`Updated lead #${args.leadId}.`, resp, resp, true);
      }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/crmWrites.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run build && npx vitest run`
Expected: clean build; everything green.

- [ ] **Step 6: Commit**

```bash
git add src/tools/contacts.ts tests/tools/crmWrites.test.ts
git commit -m "feat(leads): create + update lead write tools"
```

---

## Done criteria (2a)

- 4 new tools callable via MCP; writes guarded (flag/confirm/dry-run) with rawPayload escape hatch.
- `npx vitest run` fully green; `npm run build` clean.
- Two commits on `feat/http-transport`. **No push, no deploy.**
