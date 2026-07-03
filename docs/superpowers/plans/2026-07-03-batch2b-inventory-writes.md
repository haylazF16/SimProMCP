# Batch 2b: Inventory Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 5 write tools — `simpro_create_storage_device`, `simpro_update_storage_device`, `simpro_create_stock_take`, `simpro_update_stock_take`, `simpro_update_catalog_item`.

**Architecture:** Same pattern-clone as Batch 2a (see that plan and `simpro_create_supplier` in `src/tools/suppliers.ts`). All five tools go inside the existing `registerInventoryTools` in `src/tools/inventory.ts`; endpoints (`storageDevices`, `storageDeviceById`, `stockTakes`, `stockTakeById`, `catalogById`) already exist in `src/simpro/endpoints.ts`. Field mappings are conservative (the obviously-stable fields) with `rawPayload` as the tenant-specific escape hatch — the same precedent as `simpro_create_job`.

**Tech Stack:** TypeScript strict, Zod, MCP SDK, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-gap-fill-batch2-nonfinancial-sweep-design.md`
**Branch:** `feat/http-transport`
**Prereq:** Batch 2a merged/committed (harness conventions identical).

---

### Task 1: Storage device writes (`simpro_create_storage_device`, `simpro_update_storage_device`)

**Files:**
- Modify: `src/tools/inventory.ts` (inside `registerInventoryTools`, at the end)
- Test: `tests/tools/inventoryWrites.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/inventoryWrites.test.ts`. Same harness shape as `tests/tools/crmWrites.test.ts` but registering inventory tools:

```typescript
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerInventoryTools } from "../../src/tools/inventory.js";
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
        return { ID: 42 };
      },
      patch: async (p: string, payload: unknown) => {
        spy.patches.push({ path: p, payload });
        return { ID: 42 };
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
  registerInventoryTools(server, ctx);
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

describe("simpro_create_storage_device", () => {
  it("POSTs mapped payload when confirmed", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_storage_device", {
      confirm: true, name: "Van 7", type: "Vehicle",
    });
    expect(r.isError).toBe(false);
    expect(spy.posts[0].path).toBe("/api/v1.0/companies/4/storageDevices/");
    expect(spy.posts[0].payload).toEqual({ Name: "Van 7", Type: "Vehicle" });
  });

  it("blocks without confirm", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_storage_device", { confirm: false, name: "X" });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("Confirmation required");
  });

  it("blocks when writes disabled", async () => {
    const { ctx, spy } = makeCtx({ write: false });
    const r = await callTool(ctx, "simpro_create_storage_device", { confirm: true, name: "X" });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("Write tools are disabled");
  });

  it("dry-run echoes without sending", async () => {
    const { ctx, spy } = makeCtx({ dryRun: true });
    const r = await callTool(ctx, "simpro_create_storage_device", { confirm: true, name: "X" });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("DRY RUN");
  });
});

describe("simpro_update_storage_device", () => {
  it("PATCHes to /storageDevices/{id}", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_update_storage_device", {
      confirm: true, storageDeviceId: 8, name: "Van 7 (renamed)",
    });
    expect(r.isError).toBe(false);
    expect(spy.patches[0].path).toBe("/api/v1.0/companies/4/storageDevices/8");
    expect(spy.patches[0].payload).toEqual({ Name: "Van 7 (renamed)" });
  });

  it("rejects an empty update", async () => {
    const { ctx } = makeCtx();
    const r = await callTool(ctx, "simpro_update_storage_device", { confirm: true, storageDeviceId: 8 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No fields to update");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/inventoryWrites.test.ts`
Expected: FAIL — tools not found.

- [ ] **Step 3: Implement the two storage-device tools**

In `src/tools/inventory.ts`, extend imports (mirror contacts.ts): add `writeGuard, textResponse` to the `./_shared.js` import if missing, `confirmSchema, rawPayloadSchema` to `../utils/schemas.js`, and `pruneEmpty` from `../utils/sanitise.js`. Then, at the end of `registerInventoryTools`:

```typescript
  // ---- create storage device ----
  registerTool(
    server,
    "simpro_create_storage_device",
    "Create a storage device (warehouse / vehicle / storage location) in Simpro. Requires confirm=true. Honors SIMPRO_ENABLE_WRITE_TOOLS and SIMPRO_DRY_RUN.",
    () => (
    {
      confirm: confirmSchema,
      name: z.string().min(1).describe("Storage device name, e.g. 'Van 7' or 'Main warehouse'."),
      type: z.enum(["Warehouse", "Vehicle"]).optional().describe("Device type."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({ Name: args.name, Type: args.type });
        const path = ctx.client.companyPath(ENDPOINTS.storageDevices);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create storage device "${args.name}" in Simpro`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<{ ID?: number }>(path, payload);
        return formatRecord(`Created storage device #${resp.ID ?? "?"}.`, resp, resp, true);
      }),
  );

  // ---- update storage device ----
  registerTool(
    server,
    "simpro_update_storage_device",
    "Update a Simpro storage device (partial update). Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      storageDeviceId: idSchema,
      name: z.string().optional(),
      type: z.enum(["Warehouse", "Vehicle"]).optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({ Name: args.name, Type: args.type });
        if (Object.keys(payload).length === 0) {
          return textResponse("No fields to update — provide at least one field or rawPayload.", true);
        }
        const path = ctx.client.companyPath(ENDPOINTS.storageDeviceById(args.storageDeviceId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update storage device #${args.storageDeviceId}`,
        });
        if (blocked) return blocked;
        await ctx.client.patch(path, payload);
        return textResponse(`Updated storage device #${args.storageDeviceId}. Changed fields: ${Object.keys(payload).join(", ")}.`);
      }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/inventoryWrites.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/inventory.ts tests/tools/inventoryWrites.test.ts
git commit -m "feat(inventory): create + update storage device write tools"
```

---

### Task 2: Stock take writes (`simpro_create_stock_take`, `simpro_update_stock_take`)

**Files:**
- Modify: `src/tools/inventory.ts`
- Test: `tests/tools/inventoryWrites.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools/inventoryWrites.test.ts`:

```typescript
describe("simpro_create_stock_take", () => {
  it("POSTs mapped payload when confirmed", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_stock_take", {
      confirm: true, storageDeviceId: 8,
    });
    expect(r.isError).toBe(false);
    expect(spy.posts[0].path).toBe("/api/v1.0/companies/4/stockTakes/");
    expect(spy.posts[0].payload).toEqual({ StorageDevice: 8 });
  });

  it("blocks without confirm", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_create_stock_take", { confirm: false, storageDeviceId: 8 });
    expect(spy.posts).toHaveLength(0);
    expect(r.text).toContain("Confirmation required");
  });
});

describe("simpro_update_stock_take", () => {
  it("PATCHes rawPayload to /stockTakes/{id}", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_update_stock_take", {
      confirm: true, stockTakeId: 5, rawPayload: { Status: "Complete" },
    });
    expect(r.isError).toBe(false);
    expect(spy.patches[0].path).toBe("/api/v1.0/companies/4/stockTakes/5");
    expect(spy.patches[0].payload).toEqual({ Status: "Complete" });
  });

  it("dry-run echoes without sending", async () => {
    const { ctx, spy } = makeCtx({ dryRun: true });
    const r = await callTool(ctx, "simpro_update_stock_take", {
      confirm: true, stockTakeId: 5, rawPayload: { Status: "Complete" },
    });
    expect(spy.patches).toHaveLength(0);
    expect(r.text).toContain("DRY RUN");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/inventoryWrites.test.ts`
Expected: 4 new tests FAIL; earlier 6 PASS.

- [ ] **Step 3: Implement the two stock-take tools**

At the end of `registerInventoryTools`:

```typescript
  // ---- create stock take ----
  registerTool(
    server,
    "simpro_create_stock_take",
    "Start a new stock take for a storage device in Simpro. Requires confirm=true. Find the device with simpro_search_storage_devices. Tenant-specific fields go in rawPayload.",
    () => (
    {
      confirm: confirmSchema,
      storageDeviceId: idSchema.describe("Storage device (warehouse/vehicle) to count."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? { StorageDevice: args.storageDeviceId };
        const path = ctx.client.companyPath(ENDPOINTS.stockTakes);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create stock take for storage device #${args.storageDeviceId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<{ ID?: number }>(path, payload);
        return formatRecord(`Created stock take #${resp.ID ?? "?"}.`, resp, resp, true);
      }),
  );

  // ---- update stock take ----
  registerTool(
    server,
    "simpro_update_stock_take",
    "Update a Simpro stock take via rawPayload (e.g. {\"Status\":\"Complete\"} — stock-take fields are tenant-specific, check your Simpro API docs). Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      stockTakeId: idSchema,
      rawPayload: z.record(z.any())
        .describe("Raw Simpro PATCH payload for the stock take — exact JSON Simpro expects."),
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload;
        const path = ctx.client.companyPath(ENDPOINTS.stockTakeById(args.stockTakeId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update stock take #${args.stockTakeId}`,
        });
        if (blocked) return blocked;
        await ctx.client.patch(path, payload);
        return textResponse(`Updated stock take #${args.stockTakeId}.`);
      }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/inventoryWrites.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/inventory.ts tests/tools/inventoryWrites.test.ts
git commit -m "feat(inventory): create + update stock take write tools"
```

---

### Task 3: Catalog update (`simpro_update_catalog_item`)

**Files:**
- Modify: `src/tools/inventory.ts`
- Test: `tests/tools/inventoryWrites.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `tests/tools/inventoryWrites.test.ts`:

```typescript
describe("simpro_update_catalog_item", () => {
  it("PATCHes mapped payload to /catalogs/{id}", async () => {
    const { ctx, spy } = makeCtx();
    const r = await callTool(ctx, "simpro_update_catalog_item", {
      confirm: true, catalogItemId: 900, name: "15mm copper pipe", partNo: "CU-15",
    });
    expect(r.isError).toBe(false);
    expect(spy.patches[0].path).toBe("/api/v1.0/companies/4/catalogs/900");
    expect(spy.patches[0].payload).toEqual({ Name: "15mm copper pipe", PartNo: "CU-15" });
  });

  it("rejects an empty update", async () => {
    const { ctx } = makeCtx();
    const r = await callTool(ctx, "simpro_update_catalog_item", { confirm: true, catalogItemId: 900 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No fields to update");
  });

  it("blocks when writes disabled", async () => {
    const { ctx, spy } = makeCtx({ write: false });
    const r = await callTool(ctx, "simpro_update_catalog_item", {
      confirm: true, catalogItemId: 900, name: "X",
    });
    expect(spy.patches).toHaveLength(0);
    expect(r.text).toContain("Write tools are disabled");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/inventoryWrites.test.ts`
Expected: 3 new FAIL; earlier 10 PASS.

- [ ] **Step 3: Implement**

At the end of `registerInventoryTools`:

```typescript
  // ---- update catalog item ----
  registerTool(
    server,
    "simpro_update_catalog_item",
    "Update a Simpro catalog (parts) item — e.g. rename, change part number, archive. Partial update; requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      catalogItemId: idSchema,
      name: z.string().optional(),
      partNo: z.string().optional().describe("Part number / SKU."),
      archived: z.boolean().optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Name: args.name,
          PartNo: args.partNo,
          Archived: args.archived,
        });
        if (Object.keys(payload).length === 0) {
          return textResponse("No fields to update — provide at least one field or rawPayload.", true);
        }
        const path = ctx.client.companyPath(ENDPOINTS.catalogById(args.catalogItemId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update catalog item #${args.catalogItemId}`,
        });
        if (blocked) return blocked;
        await ctx.client.patch(path, payload);
        return textResponse(`Updated catalog item #${args.catalogItemId}. Changed fields: ${Object.keys(payload).join(", ")}.`);
      }),
  );
```

NOTE: `pruneEmpty` drops `false` booleans? Check `src/utils/sanitise.ts` — it only drops `undefined`, `null`, and empty strings, so `archived: false` survives. Good.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/inventoryWrites.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `npm run build && npx vitest run`
Expected: clean + green.

```bash
git add src/tools/inventory.ts tests/tools/inventoryWrites.test.ts
git commit -m "feat(inventory): update catalog item write tool"
```

---

## Done criteria (2b)

- 5 new guarded write tools; 13 new tests green; build clean.
- Three commits on `feat/http-transport`. **No push, no deploy.**
