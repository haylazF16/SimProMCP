# Gap-Fill Batch 2: non-financial sweep — design

**Date:** 2026-07-03
**Status:** Approved (user, this date)
**Branch:** `feat/http-transport`

## Why

The May 2026 API gap audit (`docs/SIMPRO_API_AUDIT.md`) found 67/132 endpoints covered
(51%). Batch 1 filled 3 H-priority writes (job section / PO / PO item updates). The user
wants the rest swept in one project: **every remaining non-delete, non-financial,
non-workforce-write endpoint gets a tool**, so chats stop hitting "missing tool" moments.
Coverage after this batch: ~70% (92/132). Everything still missing afterwards is missing
*on purpose* (deletes, money, scheduling/time writes).

## Scope

**In:** 26 new tools — 9 writes (create/update) + 17 long-tail reads. Detailed tables below.

**Out (deliberate):**
- **All DELETE endpoints** (23) — destructive; deferred exactly as in Batch 1.
- **Financial writes** (7): `POST/PATCH /invoices`, `POST /customerPayments`,
  `POST/PATCH /creditNotes`, `POST/PATCH /recurringInvoices`. User decision: money stays
  in the Simpro web UI for now. Financial *reads* are unaffected (mostly already covered).
- **Workforce/scheduling writes** (6): `POST/PATCH /schedules`, `POST/PATCH /timesheets`,
  `POST/PATCH /recurringJobs`. User decision (2026-07-03): these stay **read-only** —
  scheduling and time entry remain in the Simpro web UI. Their `get` reads ARE in scope
  (Batch 2c).
- Audit-table corrections: `PATCH /jobs/{id}/sections/{id}`, `PATCH /vendorOrders/{id}`,
  `PATCH /vendorOrders/{id}/catalogs/{id}` are listed as missing in the audit but were
  shipped in Batch 1 — not in scope here. (Update the audit doc as part of this batch.)
- No new transport/auth/admin work. No LibreChat config changes.

## Architecture — pattern cloning, no new machinery

Every tool follows the existing pattern in `src/tools/*.ts`:

1. **Schema:** Zod args; `idSchema`/`confirmSchema`/`rawFlagSchema`/`rawPayloadSchema`
   from `src/utils/schemas.ts`; pagination via `paginationQuery`.
2. **Endpoint:** path added to `src/simpro/endpoints.ts` (most keys already exist;
   new keys needed include `scheduleById`, `timesheetByUid`, `recurringJobs`,
   `recurringJobById`, `recurringInvoiceById`, `staffById`, `costCenterById`,
   `customerPaymentById`, `jobNoteById`, `jobSectionCostCenterById`,
   `vendorReceiptCatalogById`).
3. **Call:** `ctx.client.get/post/patch` with `ctx.client.companyPath(...)`.
4. **Writes:** `writeGuard(ctx, { confirm, method, path, payload })` — enforces
   `SIMPRO_ENABLE_WRITE_TOOLS`, explicit `confirm: true`, and `SIMPRO_DRY_RUN`
   payload-echo. Every write also accepts `rawPayload` as the tenant-specific escape
   hatch, mirroring `simpro_create_job`.
5. **Output:** `formatList` / `formatRecord`; errors through `safeRun`.
6. **Placement:** tools live in the existing domain files (`contacts.ts`,
   `scheduling.ts`, `inventory.ts`, `jobs.ts`, `customers.ts`, `financials.ts`,
   `tasks.ts`, `suppliers.ts`). No new files expected at this size.

## Tool inventory

### Batch 2a — CRM writes (the remaining H-priorities) — 4 tools

| Tool | Endpoint | Notes |
|---|---|---|
| `simpro_create_contact` | POST /contacts/ | GivenName, FamilyName, Email, WorkPhone, CellPhone, Position, + rawPayload |
| `simpro_update_contact` | PATCH /contacts/{id} | partial update, same fields |
| `simpro_create_lead` | POST /leads/ | LeadName, Customer, Site, Salesperson, + rawPayload; look-up helpers referenced in description |
| `simpro_update_lead` | PATCH /leads/{id} | partial update |

### Batch 2b — Inventory writes — 5 tools

| Tool | Endpoint |
|---|---|
| `simpro_create_stock_take` | POST /stockTakes/ |
| `simpro_update_stock_take` | PATCH /stockTakes/{id} |
| `simpro_create_storage_device` | POST /storageDevices/ |
| `simpro_update_storage_device` | PATCH /storageDevices/{id} |
| `simpro_update_catalog_item` | PATCH /catalogs/{id} |

### Batch 2c — Long-tail reads — 17 tools

| Tool | Endpoint |
|---|---|
| `simpro_list_job_notes` | GET /jobs/{id}/notes/ |
| `simpro_get_job_note` | GET /jobs/{id}/notes/{noteId} |
| `simpro_get_job_section` | GET /jobs/{id}/sections/{sectionId} |
| `simpro_list_section_cost_centres` | GET /jobs/{id}/sections/{sid}/costCenters/ |
| `simpro_get_section_cost_centre` | GET /jobs/{id}/sections/{sid}/costCenters/{ccId} |
| `simpro_list_tasks` | GET /tasks/ |
| `simpro_get_task` | GET /tasks/{id} |
| `simpro_get_staff_member` | GET /staff/{id} |
| `simpro_get_cost_centre` | GET /setup/accounts/costCenters/{id} |
| `simpro_list_customer_companies` | GET /customers/companies/ |
| `simpro_list_customer_individuals` | GET /customers/individuals/ |
| `simpro_get_customer_payment` | GET /customerPayments/{id} |
| `simpro_get_schedule` | GET /schedules/{id} |
| `simpro_get_timesheet` | GET /timesheets/{uid} |
| `simpro_get_recurring_invoice` | GET /recurringInvoices/{id} |
| `simpro_list_po_receipts` + `simpro_get_receipt_catalog` | GET /vendorOrders/{id}/receipts/, GET …/receipts/{rid}/catalogs/{cid} |

*(The last row is two tools; total reads = 17 including both. `simpro_get_task` is genuinely new — verified absent from src/ on 2026-07-03.)*

## Tool-list noise control

Tool count grows ~70 → ~95. Rules for every new tool description:
- First sentence: what it does + when to use it. Hard cap ~2 sentences unless a
  cross-reference is genuinely needed.
- Names strictly `simpro_<verb>_<entity>` (`list`/`get`/`search`/`create`/`update`).
- Writes state "Requires confirm=true." at the end, matching existing tools.

## Error handling

Unchanged: `safeRun` maps Simpro 4xx/5xx to readable messages; `writeGuard` refuses
un-flagged/un-confirmed writes; dry-run echoes payloads without sending. New reads on
missing IDs surface Simpro's 404 text as-is.

## Testing

- **Per tool (unit):** mocked-client tests in `tests/tools/` matching existing
  conventions — happy path for all; writes additionally test guard-block (no flag),
  confirm-missing rejection, and dry-run echo. Expect roughly +55 tests (~245 → ~300).
- **Final end-to-end verification (user requirement — "test all the work at the end"):**
  after all three batches, a dedicated verification pass:
  1. `npm run build` clean; `npm test` fully green.
  2. **Live smoke test** against production Simpro via MCP Inspector (space-free
     launcher path, per the established rig): every new **read** tool called once for
     real; every new **write** tool exercised with `SIMPRO_DRY_RUN=1` (payload echo, no
     mutation). Both companies spot-checked (Plumbing + Energy).
  3. Results recorded in a `docs/superpowers/verification/2026-XX-XX-batch2.md` checklist.
  4. Update `docs/SIMPRO_API_AUDIT.md` coverage numbers (including the 3 stale Batch-1
     rows).
- No GitHub/production push until the user reviews the verification results and says go.

## Rollout

One spec (this doc) → **three implementation plans** executed in order (2a → 2b → 2c),
each: implement → tests green → commit on `feat/http-transport`. The final verification
stage runs after 2c. Deploy to the Ubuntu box / prod only on explicit user approval.
LibreChat worker config is untouched — new writes remain invisible there (no write flag
in that environment).

## Acceptance criteria

1. All 26 tools registered, named per convention, with guarded writes.
2. `npm test` green including ~55 new tests; `npm run build` clean.
3. Live smoke-test checklist completed: all new reads return real data; all new writes
   dry-run correctly; zero unintended mutations in Simpro.
4. `docs/SIMPRO_API_AUDIT.md` updated: coverage ~70%, stale rows fixed, remaining gaps
   are only deletes + financial writes + workforce/scheduling writes.
5. Nothing deployed/pushed without explicit user approval.
