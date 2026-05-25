# Gap-fill Batch 1: Jobs + POs H-priority updates — design

> Status: design approved (2026-05-25). Next: implementation plan.

## Why

Batch 1 of the gap-fill rollout driven by `docs/SIMPRO_API_AUDIT.md`. The
audit surfaced 8 H-priority gaps. This batch covers 3 of them — the three
update operations on jobs+POs that the user has hit pain on in the last
24h:

- Sections get created with the wrong cost-centre target. We can attach
  cost-centres now but can't rename a section or fix its setup mid-flight.
- POs need their reference / dates / notes updated after creation.
- PO line items need quantity/price corrections without a destructive
  delete + re-add cycle.

The user explicitly chose to defer destructive (DELETE) operations to a
later batch — they want cleanup tools eventually but not yet. This spec
covers PATCH-only updates.

## Scope

**In:**
- `simpro_update_job_section` — PATCH `/jobs/{jobId}/sections/{sectionId}/`
- `simpro_update_purchase_order` — PATCH `/vendorOrders/{orderId}/`
- `simpro_update_purchase_order_item` — PATCH `/vendorOrders/{orderId}/catalogs/{catalogId}/`

**Out:**
- All DELETE tools (deferred — user explicitly chose to skip deletes this round).
- Update of customer payments, contacts, invoices (those are in batches 3–4).
- L-priority reads (list notes, get section by id, etc. — not blocking workflows).
- Any new pattern beyond extending the existing `simpro_update_X` shape.

## Components

### 1. `simpro_update_job_section`

**Endpoint:** PATCH `/jobs/{jobId}/sections/{sectionId}/`

**Inputs:**
- `confirm: boolean` (gate — same pattern as existing update tools)
- `jobId: number | string` (required)
- `sectionId: number | string` (required)
- `name?: string` (rename the section)
- `description?: string` (some sections have notes/description)
- `rawPayload?: Record<string, unknown>` (escape hatch — bypass field mapping)

**Payload shape sent to Simpro:**
```json
{
  "Name": "<new name>",
  "Description": "<new description>"
}
```
Only-provided-fields-are-sent: empty/undefined inputs are stripped via the
existing `pruneEmpty()` utility. `rawPayload` if present overrides everything.

**File:** `src/tools/jobs.ts` (sits next to `simpro_add_job_section` and the
other section-related tools).

**Endpoints helper:** Add `jobSectionById(jobId, sectionId)` to
`src/simpro/endpoints.ts`:
```ts
jobSectionById: (jobId, sectionId) =>
  `/jobs/${encodeURIComponent(String(jobId))}/sections/${encodeURIComponent(String(sectionId))}`,
```

### 2. `simpro_update_purchase_order`

**Endpoint:** PATCH `/vendorOrders/{orderId}/`

**Inputs:**
- `confirm: boolean`
- `purchaseOrderId: number | string` (required) — match the param-name pattern
  used by `simpro_get_purchase_order`
- `reference?: string`
- `notes?: string`
- `dateIssued?: string` (ISO date)
- `dateRequired?: string` (ISO date — when the order is expected)
- `status?: number | string` (status ID — Simpro's "Open"/"Sent"/"Complete" lifecycle)
- `rawPayload?: Record<string, unknown>`

**Payload sent:**
```json
{
  "Reference": "...",
  "Notes": "...",
  "DateIssued": "...",
  "DateRequired": "...",
  "Status": { "ID": <id> }
}
```

**File:** `src/tools/suppliers.ts` (confirmed via grep — that's where
`simpro_create_purchase_order` and `simpro_add_purchase_order_item` live).

**Endpoint helper:** `vendorOrderById(id)` should already exist in
`src/simpro/endpoints.ts`; verify by grepping before adding. If missing,
add it.

### 3. `simpro_update_purchase_order_item`

**Endpoint:** PATCH `/vendorOrders/{orderId}/catalogs/{catalogId}/`

**Inputs:**
- `confirm: boolean`
- `purchaseOrderId: number | string` (required)
- `catalogId: number | string` (required — the PO line item ID)
- `quantity?: number` (the most common reason to update — qty corrections)
- `price?: number` (override unit price)
- `description?: string` (override the line description)
- `rawPayload?: Record<string, unknown>`

**Payload sent:**
```json
{
  "Quantity": 5,
  "Price": 99.95,
  "Description": "..."
}
```

**File:** same file as `simpro_update_purchase_order` —
`src/tools/suppliers.ts`.

**Endpoint helper:** `vendorOrderItemById(orderId, catalogId)` ALREADY
EXISTS in `src/simpro/endpoints.ts` (confirmed via grep — line 79). Re-use
it; no additions needed.

## Pattern consistency

All three tools follow the existing `simpro_update_X` template:

1. Optional fields ONLY — only-provided-fields-are-sent semantics via
   `pruneEmpty()`.
2. `confirm: true` write-gate via the existing `writeGuard()` helper.
3. `rawPayload` escape hatch for fields we haven't typed.
4. PATCH (not PUT) — Simpro's API uses PATCH for partial updates.
5. Empty payload guard: if every provided field was empty AND no
   `rawPayload`, return a friendly `"No fields to update."` text response
   (mirror of `simpro_update_job`).
6. Returns the Simpro response wrapped in `formatRecord(...)` for
   consistency with other update tools.

## Architecture & file changes

```
src/simpro/endpoints.ts   (mod) — +1 helper (jobSectionById); verify vendorOrderById exists (add if missing)
src/tools/jobs.ts         (mod) — +1 tool (simpro_update_job_section)
src/tools/suppliers.ts    (mod) — +2 tools (simpro_update_purchase_order, simpro_update_purchase_order_item)

tests/tools/registerTool.test.ts — auto-picks up new tools (existing pattern)
tests/tools/jobs.test.ts          (if exists) or skip — light unit coverage of the new tool's payload shaping
```

No new test files required — the existing `registerTool` smoke test
automatically verifies all registered tools have valid schemas. Per-tool
unit tests are optional; the integration test surface (Claude actually
calling Simpro) is the real validation here.

## Error handling

- 404 from Simpro → `SimproApiError` propagates up; existing tool wrapper
  surfaces a clean text response with the endpoint path + remediation hint.
- 422 (validation) → same path, but the error body usually contains a hint
  like "Reference is required"; existing error formatter shows that.
- Network errors → existing retry-with-backoff in `SimproClient` handles
  transient cases; persistent errors surface as `SimproNetworkError`.

No new error-handling code needed.

## Testing

- **Lightweight:** rely on the existing `tests/tools/registerTool.test.ts`
  to verify the new tools register with valid schemas, no name conflicts,
  etc. (Auto-picks up new tools, no changes needed.)
- **Optional per-tool tests:** if implementing, follow the pattern in
  `tests/tools/jobs.test.ts` (if present) — mock the SimproClient and
  assert payload shaping + URL building. Skip if the file doesn't exist;
  the registration smoke is sufficient for v1 of this batch.
- **Live integration:** the user will exercise the tools in Claude Desktop
  after deploy. Real Simpro tenant validation > unit mocks for a typed
  wrapper this thin.

## Roll-out

- Single commit on `feat/http-transport`. Build + test + deploy via the
  standard SSH script.
- After deploy: user toggles the Claude Desktop connector OFF/ON to pick
  up the 3 new tools, starts a fresh chat, and exercises them.
- Estimated 67 total tools post-deploy (was 64; +3 from this batch).

## Future batches (NOT in this design)

Per the audit-driven rollout strategy:

- **Batch 2** — Quotes Hs+Ms (cleanup deletes deferred): explore the quote
  section/item sub-resource patterns we don't yet have. Estimated 4-6
  new tools.
- **Batch 3** — Invoices + Customer Payments Hs+Ms: 6-8 new tools.
- **Batch 4** — Customers / Sites / Contacts Hs+Ms: 4-6 new tools.
- **Batch 5** — Long-tail Ms (Recurring, Schedules, Timesheets, etc.):
  TBD count.
- **Deletes batch** (the 6 destructive tools deferred from this round):
  separate brainstorm because the safety design is meaningfully different
  (no undo, cascade behavior, etc.).
