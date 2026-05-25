# Gap-Fill Batch 1 — Jobs + POs Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3 H-priority update tools (`simpro_update_job_section`, `simpro_update_purchase_order`, `simpro_update_purchase_order_item`) following the existing `simpro_update_X` pattern. Brings the MCP server from 64 → 67 tools.

**Architecture:** Three small additions to existing files. Each tool is ~30-40 lines of TypeScript that maps zod-validated args to a Simpro PATCH payload, gates writes with `confirm: true`, and uses the existing `pruneEmpty()` utility for only-provided-fields semantics. No new patterns, no new test infrastructure.

**Tech Stack:** TypeScript ESM strict, zod for schemas, existing helpers from `_shared.ts` (`registerTool`, `writeGuard`, `formatRecord`, `safeRun`, `textResponse`), Simpro client from `simpro/client.ts`.

**Source spec:** `docs/superpowers/specs/2026-05-25-gap-fill-batch1-jobs-pos-updates-design.md`

**Branch:** `feat/http-transport`. Baseline tests: 129 passing.

---

## A note on TDD for this plan

The existing codebase has NO per-tool unit tests. The verification surface is:
1. `tests/tools/registerTool.test.ts` — auto-discovers every registered tool and verifies its schema compiles + name is unique
2. `npm run typecheck` — TypeScript validates the tool signature
3. Live testing in Claude Desktop after deploy — real Simpro tenant validates the PATCH semantics

So each tool task is: write the code → typecheck → run the registration smoke → commit. No new test files needed. This matches the existing pattern; introducing per-tool unit tests just for these 3 wrappers would be a deviation from the codebase's conventions.

---

## File map

```
src/simpro/endpoints.ts   (mod) — +1 helper: jobSectionById(jobId, sectionId)
                                   (vendorOrderById and vendorOrderItemById already exist — confirmed via grep)
src/tools/jobs.ts         (mod) — +1 tool: simpro_update_job_section
src/tools/suppliers.ts    (mod) — +2 tools: simpro_update_purchase_order, simpro_update_purchase_order_item
```

No new files. No test changes (existing `tests/tools/registerTool.test.ts` auto-picks up new tools).

---

## Task 1: Add `jobSectionById` endpoint helper

**Files:**
- Modify: `src/simpro/endpoints.ts`

- [ ] **Step 1.1: Locate the existing `jobSections` helper**

Open `src/simpro/endpoints.ts` and find the block around line 42-46:

```ts
  jobs: "/jobs/",
  jobById: (id: string | number) => `/jobs/${encodeURIComponent(String(id))}`,
  jobNotes: (jobId: string | number) => `/jobs/${encodeURIComponent(String(jobId))}/notes/`,
  jobSections: (jobId: string | number) => `/jobs/${encodeURIComponent(String(jobId))}/sections/`,
  jobSectionCostCenters: (jobId: string | number, sectionId: string | number) =>
    `/jobs/${encodeURIComponent(String(jobId))}/sections/${encodeURIComponent(String(sectionId))}/costCenters/`,
```

- [ ] **Step 1.2: Add `jobSectionById` between `jobSections` and `jobSectionCostCenters`**

Insert ONE new line so the block reads:

```ts
  jobs: "/jobs/",
  jobById: (id: string | number) => `/jobs/${encodeURIComponent(String(id))}`,
  jobNotes: (jobId: string | number) => `/jobs/${encodeURIComponent(String(jobId))}/notes/`,
  jobSections: (jobId: string | number) => `/jobs/${encodeURIComponent(String(jobId))}/sections/`,
  jobSectionById: (jobId: string | number, sectionId: string | number) =>
    `/jobs/${encodeURIComponent(String(jobId))}/sections/${encodeURIComponent(String(sectionId))}`,
  jobSectionCostCenters: (jobId: string | number, sectionId: string | number) =>
    `/jobs/${encodeURIComponent(String(jobId))}/sections/${encodeURIComponent(String(sectionId))}/costCenters/`,
```

Note the URL has NO trailing slash (matches the pattern of `jobById`, `vendorOrderById`, etc. — Simpro accepts both but our convention for the "by ID" helpers omits the slash).

- [ ] **Step 1.3: Typecheck**

Run: `npm run typecheck`
Expected: clean (zero errors).

- [ ] **Step 1.4: Verify no test breakage**

Run: `npm test`
Expected: 129 tests still pass (no functional changes yet).

- [ ] **Step 1.5: Commit**

```bash
git add src/simpro/endpoints.ts
git commit -m "feat(endpoints): add jobSectionById helper for PATCH /jobs/{id}/sections/{sid}"
```

---

## Task 2: `simpro_update_job_section`

**Files:**
- Modify: `src/tools/jobs.ts`

Mirror the existing `simpro_update_job` (lines ~170-203). Place the new tool immediately AFTER `simpro_update_job` and BEFORE the section beginning with `// ---- 23. list job statuses (sampled) ----`.

- [ ] **Step 2.1: Read the existing `simpro_update_job` for the exact template**

Open `src/tools/jobs.ts` and find the `simpro_update_job` block (search for `"simpro_update_job"`). Read it end-to-end to confirm the pattern:
- 5-arg `registerTool(server, name, description, () => schema, () => async handler)` signature
- `safeRun(async () => { ... })` wrapping the body
- `payload = args.rawPayload ?? pruneEmpty({...})`
- Empty-payload guard: `if (Object.keys(payload).length === 0) return textResponse("No fields to update.", true);`
- `writeGuard` call with `confirm/method/path/payload/summary`
- Returns via `formatRecord(...)`

- [ ] **Step 2.2: Add the new tool**

Insert this block immediately AFTER the closing `);` of `simpro_update_job` and BEFORE `// ---- 23. list job statuses (sampled) ----`:

```ts
  // ---- update_job_section ----
  // Sections live as a sub-resource of jobs; this tool renames or otherwise
  // updates an existing section after creation. Cost-centre line items on a
  // section are managed via simpro_add_section_cost_centre / future delete
  // tool — NOT through this PATCH (which only mutates the section's own
  // fields like Name and Description).
  registerTool(
    server,
    "simpro_update_job_section",
    "Update an existing section on a Simpro job (e.g. rename it). Only provided fields are sent. Requires confirm=true. Use simpro_list_job_sections to find the sectionId. For cost-centre line items use simpro_add_section_cost_centre.",
    () => (
    {
      confirm: confirmSchema,
      jobId: idSchema,
      sectionId: idSchema,
      name: z.string().optional().describe("New section name."),
      description: z.string().optional().describe("New section description / notes."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Name: args.name,
          Description: args.description,
        });
        if (Object.keys(payload).length === 0) return textResponse("No fields to update.", true);
        const path = ctx.client.companyPath(ENDPOINTS.jobSectionById(args.jobId, args.sectionId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update section #${args.sectionId} of job #${args.jobId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<Record<string, unknown>>(path, payload);
        return formatRecord(`Updated section #${args.sectionId} of job #${args.jobId}.`, resp, resp, true);
      }),
  );
```

- [ ] **Step 2.3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2.4: Run the registration smoke test**

Run: `npx vitest run tests/tools/registerTool.test.ts`
Expected: PASS. This test auto-discovers all registered tools — it will fail if the new tool's schema is invalid, the name conflicts with an existing one, or the registration signature is wrong.

- [ ] **Step 2.5: Run the full suite**

Run: `npm test`
Expected: 129 tests still pass (count unchanged — no new test files).

- [ ] **Step 2.6: Commit**

```bash
git add src/tools/jobs.ts
git commit -m "feat(jobs): add simpro_update_job_section (PATCH /jobs/{id}/sections/{sid})"
```

---

## Task 3: `simpro_update_purchase_order`

**Files:**
- Modify: `src/tools/suppliers.ts`

PO tools live in `suppliers.ts` (Simpro calls them "vendor orders"). The existing `simpro_create_purchase_order` and `simpro_add_purchase_order_item` are in this file. Place the new tool immediately AFTER the existing `simpro_add_purchase_order_item` registration.

- [ ] **Step 3.1: Locate the insertion point**

Open `src/tools/suppliers.ts` and find the `simpro_add_purchase_order_item` block (search for `"simpro_add_purchase_order_item"`). The new `simpro_update_purchase_order` goes immediately after its closing `);`.

If you can't find a clean insertion point because the file ends right after that registration, just add it before the final closing `}` of the surrounding `register*Tools(...)` function.

- [ ] **Step 3.2: Add the new tool**

Insert:

```ts
  // ---- update_purchase_order ----
  // Update the header fields of an existing PO — reference, dates, notes,
  // status. Line items on the PO are managed via
  // simpro_add_purchase_order_item / simpro_update_purchase_order_item.
  registerTool(
    server,
    "simpro_update_purchase_order",
    "Update an existing Simpro purchase order's header fields (reference, dates, status, notes). Only provided fields are sent. Requires confirm=true. For line items use simpro_add_purchase_order_item or simpro_update_purchase_order_item.",
    () => (
    {
      confirm: confirmSchema,
      purchaseOrderId: idSchema,
      reference: z.string().optional().describe("Free-text reference / PO number printed on the document."),
      notes: z.string().optional().describe("Internal notes attached to the PO."),
      dateIssued: isoDateSchema,
      dateRequired: isoDateSchema,
      status: z.union([z.number(), z.string()]).optional()
        .describe("PO status ID — Simpro's open/sent/complete lifecycle."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Reference: args.reference,
          Notes: args.notes,
          DateIssued: args.dateIssued,
          DateRequired: args.dateRequired,
          Status: args.status !== undefined ? { ID: args.status } : undefined,
        });
        if (Object.keys(payload).length === 0) return textResponse("No fields to update.", true);
        const path = ctx.client.companyPath(ENDPOINTS.vendorOrderById(args.purchaseOrderId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update purchase order #${args.purchaseOrderId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<Record<string, unknown>>(path, payload);
        return formatRecord(`Updated purchase order #${args.purchaseOrderId}.`, resp, resp, true);
      }),
  );
```

- [ ] **Step 3.3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3.4: Registration smoke**

Run: `npx vitest run tests/tools/registerTool.test.ts`
Expected: PASS.

- [ ] **Step 3.5: Full suite**

Run: `npm test`
Expected: 129 tests still pass.

- [ ] **Step 3.6: Commit**

```bash
git add src/tools/suppliers.ts
git commit -m "feat(suppliers): add simpro_update_purchase_order (PATCH /vendorOrders/{id})"
```

---

## Task 4: `simpro_update_purchase_order_item`

**Files:**
- Modify: `src/tools/suppliers.ts`

Place this immediately AFTER the `simpro_update_purchase_order` registration you just added (same surrounding function body).

- [ ] **Step 4.1: Add the new tool**

Insert immediately after `simpro_update_purchase_order`:

```ts
  // ---- update_purchase_order_item ----
  // Update an existing PO line item — typically used to correct quantity
  // or unit price without the destructive "delete then re-add" cycle.
  // Use simpro_list_purchase_order_items to find the catalogId (the line
  // item's ID, distinct from the underlying part's catalog ID — Simpro
  // overloads the term).
  registerTool(
    server,
    "simpro_update_purchase_order_item",
    "Update an existing line item on a Simpro purchase order (e.g. correct quantity or unit price). Only provided fields are sent. Requires confirm=true. Use simpro_list_purchase_order_items to find the catalogId.",
    () => (
    {
      confirm: confirmSchema,
      purchaseOrderId: idSchema,
      catalogId: idSchema,
      quantity: z.number().optional().describe("New quantity for this line item."),
      price: z.number().optional().describe("Override unit price for this line item."),
      description: z.string().optional().describe("Override the line description."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Quantity: args.quantity,
          Price: args.price,
          Description: args.description,
        });
        if (Object.keys(payload).length === 0) return textResponse("No fields to update.", true);
        const path = ctx.client.companyPath(ENDPOINTS.vendorOrderItemById(args.purchaseOrderId, args.catalogId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update PO #${args.purchaseOrderId} line item #${args.catalogId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<Record<string, unknown>>(path, payload);
        return formatRecord(`Updated PO #${args.purchaseOrderId} line item #${args.catalogId}.`, resp, resp, true);
      }),
  );
```

- [ ] **Step 4.2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4.3: Registration smoke**

Run: `npx vitest run tests/tools/registerTool.test.ts`
Expected: PASS.

- [ ] **Step 4.4: Full suite**

Run: `npm test`
Expected: 129 tests still pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/tools/suppliers.ts
git commit -m "feat(suppliers): add simpro_update_purchase_order_item (PATCH /vendorOrders/{id}/catalogs/{cid})"
```

---

## Task 5: Push + deploy + verify

**Files:** none

- [ ] **Step 5.1: Pre-flight**

Run: `npm run typecheck && npm run build && npm test`
Expected: all clean, 129 tests pass.

- [ ] **Step 5.2: Push to origin**

```bash
git push origin feat/http-transport
```

- [ ] **Step 5.3: Deploy to Ubuntu and verify 67 tools live**

```bash
ssh goldman-ubuntu 'bash -s' <<'EOF'
PW='Gold@1234'; run() { echo "$PW" | sudo -S -p '' "$@"; }
cd /opt/simpro-mcp
run -u simpro-mcp git checkout -- package-lock.json
run -u simpro-mcp git pull --ff-only 2>&1 | tail -2
run -u simpro-mcp npm ci 2>&1 | tail -1
run -u simpro-mcp npm run build 2>&1 | tail -1
run -u simpro-mcp npm prune --omit=dev 2>&1 | tail -1
run systemctl restart simpro-mcp
sleep 2
run systemctl is-active simpro-mcp
TOKEN='smcp_RVbocdemffvtaM1P2jgbCQYyuWhYtBCdG4m5HChGX7k'
echo --- total tool count (should be 67) ---
curl -s -N -X POST http://127.0.0.1:3001/mcp/plumbing \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | grep -oE '"name":"simpro_[a-z_]+"' | wc -l
echo --- new tools present? ---
curl -s -N -X POST http://127.0.0.1:3001/mcp/plumbing \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | grep -oE 'simpro_update_(job_section|purchase_order|purchase_order_item)' | sort | uniq
EOF
```

Expected:
- Service: `active`
- Tool count: `67`
- All three new tool names appear in the output.

- [ ] **Step 5.4: User toggle reminder**

After deploy, the user must toggle the Claude Desktop connector OFF/ON in Settings → Connectors (the well-known cache-refresh dance) before Claude sees the new tools. Then a fresh chat to pick up the new tool list. This is a known friction; flag it in the final report.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| `simpro_update_job_section` (PATCH /jobs/{id}/sections/{sid}) | Task 2 |
| `simpro_update_purchase_order` (PATCH /vendorOrders/{id}) | Task 3 |
| `simpro_update_purchase_order_item` (PATCH /vendorOrders/{id}/catalogs/{cid}) | Task 4 |
| `jobSectionById` endpoint helper | Task 1 |
| `vendorOrderById` / `vendorOrderItemById` already exist | Confirmed via grep in plan header; no task needed |
| Pattern consistency (confirm-gate, pruneEmpty, rawPayload, empty-payload guard, PATCH, formatRecord) | All three tool tasks (2/3/4) use the exact `simpro_update_job` template |
| Roll-out (build + deploy via SSH script + connector toggle reminder) | Task 5 |
| Out of scope (deletes, batches 2-5) | Not in plan — handled by future brainstorm cycles |

**2. Placeholder scan:** All steps contain the actual code to write. No TBD/TODO/vague directives. The "read the existing pattern" step in Task 2 (Step 2.1) is a deliberate context-loading step, not a placeholder — it points at a specific block in the codebase as the template.

**3. Type consistency:**
- `args.confirm`, `args.jobId`, `args.sectionId`, `args.purchaseOrderId`, `args.catalogId` — consistent naming across all three tools, matching the existing `simpro_get_purchase_order` / `simpro_get_job` parameter conventions.
- All three tools return `formatRecord(...)` with the same arg pattern: `(headerString, primarySource, fullSource, includeRaw=true)`.
- `ENDPOINTS.jobSectionById` (added in Task 1) is consumed by Task 2; `ENDPOINTS.vendorOrderById` (already exists) is consumed by Task 3; `ENDPOINTS.vendorOrderItemById` (already exists) is consumed by Task 4. Signatures match the grepped definitions.
- `pruneEmpty()`, `writeGuard()`, `safeRun()`, `textResponse()`, `formatRecord()`, `registerTool()` — all already imported in both `jobs.ts` and `suppliers.ts` (verified from the import lines shown in the plan header context). No new imports needed.

Plan is complete and self-consistent.
