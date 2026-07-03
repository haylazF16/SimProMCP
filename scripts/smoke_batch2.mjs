// Batch-2 end-to-end smoke: drives dist/index.js over MCP stdio against the
// LIVE Simpro tenant. New READ tools are called for real; new WRITE tools run
// with SIMPRO_DRY_RUN=true (payload echo, zero mutations).
//
// Usage:  SIMPRO_BASE_URL=... SIMPRO_API_KEY=... SIMPRO_COMPANY_ID=4 node scripts/smoke_batch2.mjs
// Never pass the key as a CLI arg — env only.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const required = ["SIMPRO_BASE_URL", "SIMPRO_API_KEY", "SIMPRO_COMPANY_ID"];
for (const k of required) if (!process.env[k]) { console.error(`missing env ${k}`); process.exit(1); }

// LESSON (2026-07-03): the repo's .env loads with override:true and clobbers
// process env — the first smoke run silently went live (created a real
// contact). Defense 1: spawn the server from an .env-free cwd so dotenv finds
// nothing. Defense 2: canary probe below refuses to run writes unless DRY RUN
// is proven active.
import * as path from "node:path";
import * as os from "node:os";
import { mkdtempSync } from "node:fs";
const cleanCwd = mkdtempSync(path.join(os.tmpdir(), "smoke2-"));
const distEntry = path.resolve("dist/index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [distEntry],
  cwd: cleanCwd,
  env: {
    ...process.env,
    SIMPRO_ENABLE_WRITE_TOOLS: "true",
    SIMPRO_DRY_RUN: "true",          // hard safety: writes never reach Simpro
    SIMPRO_TRANSPORT: "stdio",
  },
});
const client = new Client({ name: "batch2-smoke", version: "1.0.0" });
await client.connect(transport);

const results = [];
async function call(name, args, expect = "ok") {
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content?.[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 160);
    const isError = res.isError === true;
    results.push({ name, isError, expect, text });
    console.log(`${isError ? "ERR " : "OK  "} ${name} :: ${text}`);
    return { isError, text };
  } catch (e) {
    results.push({ name, isError: true, expect, text: String(e).slice(0, 160) });
    console.log(`THROW ${name} :: ${String(e).slice(0, 160)}`);
    return { isError: true, text: String(e) };
  }
}
const firstId = (t) => (t.match(/#(\d+)/) ? Number(t.match(/#(\d+)/)[1]) : undefined);

console.log(`\n== company ${process.env.SIMPRO_COMPANY_ID} :: discovery ==`);
const jobs = await call("simpro_search_jobs", { pageSize: 1 });
const jobId = firstId(jobs.text);
let sectionId, ccId, noteId;
if (jobId) {
  const secs = await call("simpro_list_job_sections", { jobId });
  sectionId = firstId(secs.text);
  const notes = await call("simpro_list_job_notes", { jobId, pageSize: 5 });
  noteId = firstId(notes.text);
  if (sectionId) {
    const ccs = await call("simpro_list_section_cost_centres", { jobId, sectionId });
    ccId = firstId(ccs.text);
  }
}
const staff = await call("simpro_list_staff", {});
const staffId = firstId(staff.text);
const tasks = await call("simpro_list_tasks", { pageSize: 5 });
const taskId = firstId(tasks.text);
const costCentres = await call("simpro_list_cost_centres", {});
const costCentreId = firstId(costCentres.text);
const pays = await call("simpro_search_customer_payments", { pageSize: 1 });
const paymentId = firstId(pays.text);
const scheds = await call("simpro_search_schedules", { pageSize: 1 });
const scheduleId = firstId(scheds.text);
const recInv = await call("simpro_search_recurring_invoices", { pageSize: 1 });
const recurringInvoiceId = firstId(recInv.text);
const pos = await call("simpro_search_purchase_orders", { pageSize: 1 });
const purchaseOrderId = firstId(pos.text);

console.log("\n== NEW READ TOOLS (live) ==");
if (jobId && noteId) await call("simpro_get_job_note", { jobId, noteId }); else console.log("SKIP simpro_get_job_note (no notes on sampled job)");
if (jobId && sectionId) await call("simpro_get_job_section", { jobId, sectionId }); else console.log("SKIP simpro_get_job_section");
if (jobId && sectionId && ccId) await call("simpro_get_section_cost_centre", { jobId, sectionId, costCentreId: ccId }); else console.log("SKIP simpro_get_section_cost_centre");
if (taskId) await call("simpro_get_task", { taskId }); else console.log("SKIP simpro_get_task (no tasks)");
if (staffId) await call("simpro_get_staff_member", { staffId }); else console.log("SKIP simpro_get_staff_member");
if (costCentreId) await call("simpro_get_cost_centre", { costCentreId }); else console.log("SKIP simpro_get_cost_centre");
await call("simpro_list_customer_companies", { pageSize: 3 });
await call("simpro_list_customer_individuals", { pageSize: 3 });
if (paymentId) await call("simpro_get_customer_payment", { paymentId }); else console.log("SKIP simpro_get_customer_payment (none found)");
if (scheduleId) await call("simpro_get_schedule", { scheduleId }); else console.log("SKIP simpro_get_schedule (none found)");
// timesheets: search first, UID shape is tenant-specific
const ts = await call("simpro_search_timesheets", { pageSize: 1 });
console.log("NOTE simpro_get_timesheet needs a UID from the search output above — verify manually if a UID is visible.");
if (recurringInvoiceId) await call("simpro_get_recurring_invoice", { recurringInvoiceId }); else console.log("SKIP simpro_get_recurring_invoice (none found)");
let receiptId, receiptCatalogId;
if (purchaseOrderId) {
  const rec = await call("simpro_list_po_receipts", { purchaseOrderId });
  receiptId = firstId(rec.text);
  if (receiptId) {
    const items = await call("simpro_list_supplier_invoice_items", { purchaseOrderId, supplierInvoiceId: receiptId });
    receiptCatalogId = firstId(items.text);
    if (receiptCatalogId) await call("simpro_get_receipt_catalog", { purchaseOrderId, receiptId, catalogId: receiptCatalogId });
    else console.log("SKIP simpro_get_receipt_catalog (no line items)");
  } else console.log("SKIP simpro_get_receipt_catalog (no receipts on sampled PO)");
}

console.log("\n== WRITE-SAFETY CANARY ==");
// Harmless probe: PATCH on a nonexistent catalog ID. If dry-run is active we
// get the DRY RUN echo; if writes were somehow live we'd get a 404 (still no
// mutation) — and we ABORT before any create call can run.
const canary = await call("simpro_update_catalog_item", { confirm: true, catalogItemId: 999999999, name: "canary" });
if (!/DRY RUN/.test(canary.text)) {
  console.error("ABORT: dry-run NOT active (canary did not echo DRY RUN). No create writes attempted.");
  await client.close();
  process.exit(2);
}
console.log("Canary confirms DRY RUN active — proceeding with write echoes.");

console.log("\n== NEW WRITE TOOLS (dry-run — must all echo DRY RUN, zero mutations) ==");
const wr = [];
wr.push(await call("simpro_create_contact", { confirm: true, givenName: "Smoke", familyName: "Test", email: "smoke@test.co" }, "dry"));
wr.push(await call("simpro_update_contact", { confirm: true, contactId: 1, email: "smoke2@test.co" }, "dry"));
wr.push(await call("simpro_create_lead", { confirm: true, leadName: "Smoke lead", customerId: 1 }, "dry"));
wr.push(await call("simpro_update_lead", { confirm: true, leadId: 1, leadName: "Smoke lead renamed" }, "dry"));
wr.push(await call("simpro_create_storage_device", { confirm: true, name: "Smoke Van", type: "Vehicle" }, "dry"));
wr.push(await call("simpro_update_storage_device", { confirm: true, storageDeviceId: 1, name: "Smoke Van 2" }, "dry"));
wr.push(await call("simpro_create_stock_take", { confirm: true, storageDeviceId: 1 }, "dry"));
wr.push(await call("simpro_update_stock_take", { confirm: true, stockTakeId: 1, rawPayload: { Status: "Complete" } }, "dry"));
wr.push(await call("simpro_update_catalog_item", { confirm: true, catalogItemId: 1, name: "Smoke part" }, "dry"));
const dryOk = wr.every((r) => !r.isError && /DRY RUN/.test(r.text));
console.log(`\nAll 9 writes dry-ran without sending: ${dryOk ? "YES" : "NO — CHECK ABOVE"}`);

const errs = results.filter((r) => r.isError);
console.log(`\n== SUMMARY: ${results.length} calls, ${errs.length} errors ==`);
for (const e of errs) console.log(`  ERR ${e.name}: ${e.text}`);
await client.close();
process.exit(0);
