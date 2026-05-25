// Supplier tools. In Simpro, "suppliers" are stored under the /vendors/
// endpoint — both terms refer to the same records. We expose them with
// "supplier" naming to match how Goldman Plumbing staff talk about them.
//
// Verified live against goldmanplumbingservices.simprosuite.com — the
// tenant has ~4,099 vendor records. Filter column for free-text search
// is `Name` (substring match with SQL-style %wildcards%).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { buildKeywordFilter, likeWildcard } from "../utils/filter.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, writeGuard, registerTool } from "./_shared.js";
import { idSchema, rawFlagSchema, rawPayloadSchema, confirmSchema, addressSchema, isoDateSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { resolveJobAssignment } from "../utils/resolveJobAssignment.js";

interface SimproSupplier {
  ID?: number;
  Name?: string;
  EIN?: string;          // ABN in Australia
  CompanyNo?: string;
  Email?: string;
  Phone?: string;
  Website?: string;
  Address?: { Address?: string; City?: string; State?: string; PostalCode?: string; Country?: string };
  BillingAddress?: { Address?: string; City?: string; State?: string; PostalCode?: string; Country?: string };
  Archived?: boolean;
  [key: string]: unknown;
}

interface SimproVendorOrder {
  ID?: number;
  Stage?: string;
  Reference?: string;
  Totals?: { ExTax?: number; IncTax?: number };
  Vendor?: { ID?: number; Name?: string };
  DateIssued?: string;
  [key: string]: unknown;
}

interface SimproVendorReceipt {
  ID?: number;
  VendorInvoiceNo?: string;
  DateIssued?: string;
  DueDate?: string;
  Vendor?: { ID?: number; Name?: string };
  VendorOrder?: { ID?: number; Stage?: string; Reference?: string };
  Total?: number | { ExTax?: number; IncTax?: number };
  [key: string]: unknown;
}

/**
 * Resolve a supplier by name → ID. Mirrors the customer resolver but uses
 * the vendor `Name` column.
 */
async function resolveSupplierByName(
  ctx: ToolCtx,
  name: string,
  maxCandidates = 10,
): Promise<{ matchedId?: number; note: string; candidates: { ID: number; Name?: string }[] }> {
  const path = ctx.client.companyPath(ENDPOINTS.suppliers);
  const resp = await ctx.client.get<unknown>(path, {
    page: 1,
    pageSize: maxCandidates,
    columns: "ID,Name",
    Name: likeWildcard(name),
  });
  const candidates = (extractList(resp) as { ID?: number; Name?: string }[])
    .filter((c) => typeof c.ID === "number")
    .map((c) => ({ ID: c.ID as number, Name: c.Name }));

  if (candidates.length === 0) {
    return { candidates: [], note: `No supplier found with a name containing "${name}".` };
  }
  if (candidates.length === 1) {
    return {
      matchedId: candidates[0].ID,
      candidates,
      note: `Resolved supplier name "${name}" → #${candidates[0].ID} ${candidates[0].Name ?? ""}`,
    };
  }
  return {
    candidates,
    note:
      `Multiple suppliers match "${name}" — please re-run with a specific supplierId. Candidates:\n` +
      candidates.map((c) => `  - #${c.ID} ${c.Name ?? ""}`).join("\n"),
  };
}

export function registerSupplierTools(server: McpServer, ctx: ToolCtx) {
  // ---- search suppliers ----
  registerTool(
    server,
    "simpro_search_suppliers",
    "Search Simpro suppliers (called 'vendors' in the API). `query` matches the supplier Name (substring). Returns a paginated list. NOTE: Goldman Plumbing's tenant has ~4,000+ suppliers — always pass a query unless you really want to page through everything.",
    () => (
    {
      query: z.string().optional()
        .describe("Free-text search against the supplier's Name."),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    }
    ),
    () => async ({ query, page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.suppliers);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields this tool's formatRow reads.
          columns: "ID,Name,Phone,Email,Archived",
          ...buildKeywordFilter(query, "Name"),
        });
        const items = extractList(resp) as SimproSupplier[];
        return formatList(
          items, undefined, pg.page, pg.pageSize,
          (s) =>
            `#${s.ID ?? "?"} ${s.Name ?? "(unnamed)"}` +
            `${s.Phone ? ` tel:${s.Phone}` : ""}` +
            `${s.Email ? ` <${s.Email}>` : ""}` +
            `${s.Archived ? " [archived]" : ""}`,
          resp,
          raw === true,
        );
      }),
  );

  // ---- get supplier ----
  registerTool(
    server,
    "simpro_get_supplier",
    "Get full details of a Simpro supplier (vendor) by ID, including address, banking, payment terms.",
    () => (
    { supplierId: idSchema, raw: rawFlagSchema }
    ),
    () => async ({ supplierId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.supplierById(supplierId));
        const resp = await ctx.client.get<SimproSupplier>(path);
        return formatRecord(`Supplier #${resp.ID ?? supplierId}: ${resp.Name ?? "(unnamed)"}`, resp, resp, raw === true);
      }),
  );

  // ---- create supplier ----
  registerTool(
    server,
    "simpro_create_supplier",
    "Create a new supplier in Simpro. Requires confirm=true. Honors SIMPRO_ENABLE_WRITE_TOOLS and SIMPRO_DRY_RUN.",
    () => (
    {
      confirm: confirmSchema,
      name: z.string().min(1).describe("Supplier company name."),
      ein: z.string().optional().describe("Tax ID / ABN."),
      companyNo: z.string().optional().describe("Company registration number."),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      website: z.string().url().optional(),
      address: addressSchema,
      billingAddress: addressSchema,
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Name: args.name,
          EIN: args.ein,
          CompanyNo: args.companyNo,
          Email: args.email,
          Phone: args.phone,
          Website: args.website,
          Address: args.address,
          BillingAddress: args.billingAddress,
        });
        const path = ctx.client.companyPath(ENDPOINTS.suppliers);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create supplier "${args.name}" in Simpro`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<SimproSupplier>(path, payload);
        return formatRecord(`Created supplier #${resp.ID ?? "?"} (${resp.Name ?? args.name}).`, resp, resp, true);
      }),
  );

  // ---- update supplier ----
  registerTool(
    server,
    "simpro_update_supplier",
    "Update a Simpro supplier. Only provided fields are sent (PATCH semantics). Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      supplierId: idSchema,
      name: z.string().optional(),
      ein: z.string().optional(),
      companyNo: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      website: z.string().url().optional(),
      address: addressSchema,
      billingAddress: addressSchema,
      archived: z.boolean().optional().describe("Set true to archive (soft-delete) the supplier."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Name: args.name,
          EIN: args.ein,
          CompanyNo: args.companyNo,
          Email: args.email,
          Phone: args.phone,
          Website: args.website,
          Address: args.address,
          BillingAddress: args.billingAddress,
          Archived: args.archived,
        });
        if (Object.keys(payload).length === 0) return textResponse("No fields provided to update.", true);
        const path = ctx.client.companyPath(ENDPOINTS.supplierById(args.supplierId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update supplier #${args.supplierId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<SimproSupplier>(path, payload);
        return formatRecord(`Updated supplier #${args.supplierId}.`, resp, resp, true);
      }),
  );

  // ---- search vendor orders (purchase orders) ----
  registerTool(
    server,
    "simpro_search_purchase_orders",
    "Search vendor orders (purchase orders raised to suppliers). To find POs FOR a supplier, pass `supplierId` if known, or `supplierName` to auto-resolve. The `query` field matches the PO `Reference` field (which usually contains a job number).",
    () => (
    {
      query: z.string().optional().describe("Free-text search against the PO's Reference field."),
      supplierName: z.string().optional()
        .describe("Supplier name (substring). Resolved to supplierId automatically."),
      supplierId: idSchema.optional()
        .describe("Exact Simpro supplier (vendor) ID."),
      stage: z.string().optional().describe("Filter by stage, e.g. 'Approved', 'Pending'."),
      dateFrom: isoDateSchema,
      dateTo: isoDateSchema,
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        let supplierId = args.supplierId;
        let resolvedNote = "";
        if (!supplierId && args.supplierName) {
          const lookup = await resolveSupplierByName(ctx, args.supplierName);
          if (!lookup.matchedId) return textResponse(lookup.note, true);
          supplierId = lookup.matchedId;
          resolvedNote = lookup.note + "\n\n";
        }
        const path = ctx.client.companyPath(ENDPOINTS.vendorOrders);
        const pg = paginationQuery(ctx.config, args.page, args.pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields this tool's formatRow reads.
          columns: "ID,Reference,Vendor,Stage,Totals,DateIssued",
          ...buildKeywordFilter(args.query, "Reference"),
          // Simpro filters by dotted column path on relations.
          "Vendor.ID": supplierId,
          Stage: args.stage,
          DateIssuedFrom: args.dateFrom,
          DateIssuedTo: args.dateTo,
        });
        const items = extractList(resp) as SimproVendorOrder[];
        const result = formatList(
          items, undefined, pg.page, pg.pageSize,
          (vo) =>
            `#${vo.ID ?? "?"}` +
            `${vo.Reference ? ` — ${vo.Reference}` : ""}` +
            `${vo.Vendor?.Name ? ` | supplier: ${vo.Vendor.Name}` : ""}` +
            `${vo.Stage ? ` | stage: ${vo.Stage}` : ""}` +
            `${vo.Totals?.IncTax !== undefined ? ` | total: ${vo.Totals.IncTax}` : ""}` +
            `${vo.DateIssued ? ` | issued: ${vo.DateIssued}` : ""}`,
          resp, args.raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        return result;
      }),
  );

  // ---- get purchase order ----
  registerTool(
    server,
    "simpro_get_purchase_order",
    "Get full details of a Simpro vendor order (purchase order) by ID.",
    () => (
    { purchaseOrderId: idSchema, raw: rawFlagSchema }
    ),
    () => async ({ purchaseOrderId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.vendorOrderById(purchaseOrderId));
        const resp = await ctx.client.get<SimproVendorOrder>(path);
        return formatRecord(
          `Purchase Order #${resp.ID ?? purchaseOrderId}${resp.Reference ? ` (${resp.Reference})` : ""}`,
          resp, resp, raw === true,
        );
      }),
  );

  // ---- create purchase order ----
  // Probed live against Goldman tenant.
  // Required: Vendor (int), StorageDevice (int), AssignedTo (int composite ID
  //   that maps Job + Section + CostCenter — fetched via resolveJobAssignment).
  // Optional: DateIssued (defaults to today), Reference, VendorNotes, PrivateNotes.
  //
  // POs in Simpro must be tied to a job's cost centre — otherwise the cost
  // doesn't roll up against any work and the PO is meaningless. We REQUIRE
  // jobId for that reason. If the job has multiple cost centres, the user
  // must also specify which one.
  registerTool(
    server,
    "simpro_create_purchase_order",
    "Create a new purchase order in Simpro, attached to a specific job's cost centre. Requires confirm=true. The PO is bound to the job so its cost rolls up correctly. If the job has multiple cost centres, also pass costCenterId. Use simpro_search_suppliers to find supplierId, simpro_search_jobs to find jobId. After creation, use simpro_add_purchase_order_item for line items.",
    () => (
    {
      confirm: confirmSchema,
      jobId: idSchema
        .describe("Simpro job ID this PO is being raised for. REQUIRED — POs must attach to a job."),
      costCenterId: idSchema.optional()
        .describe("Cost centre ID on that job. Only needed if the job has more than one cost centre. List them with simpro_list_cost_centres or by reading the job."),
      supplierId: idSchema.optional()
        .describe("Simpro supplier (vendor) ID. Find with simpro_search_suppliers. Either this OR supplierName must be provided."),
      supplierName: z.string().optional()
        .describe("Alternative to supplierId: the tool will resolve the name to an ID."),
      storageDeviceId: idSchema.optional()
        .describe("Where the goods will be received. Find with simpro_search_storage_devices. Defaults to the main warehouse (ID 75) if omitted."),
      dateIssued: isoDateSchema.describe("ISO date (YYYY-MM-DD). Defaults to today."),
      reference: z.string().optional()
        .describe("Free text reference, e.g. 'Job No. 130602 - WATER LEAK'. Auto-generated if omitted."),
      vendorNotes: z.string().optional()
        .describe("Notes visible to the supplier (HTML accepted)."),
      privateNotes: z.string().optional()
        .describe("Internal-only notes."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        // Resolve supplier name -> id.
        let supplierId = args.supplierId;
        const noteLines: string[] = [];
        if (!supplierId && args.supplierName) {
          const lookup = await resolveSupplierByName(ctx, args.supplierName);
          if (!lookup.matchedId) return textResponse(lookup.note, true);
          supplierId = lookup.matchedId;
          noteLines.push(lookup.note);
        }
        if (!supplierId) {
          return textResponse("Either supplierId or supplierName is required.", true);
        }

        // Resolve job + cost-centre -> AssignedTo composite ID.
        const assignment = await resolveJobAssignment(ctx.client, args.jobId, args.costCenterId);
        if (!assignment.matchedId) {
          return textResponse(assignment.note, true);
        }
        noteLines.push(assignment.note);

        const payload = args.rawPayload ?? pruneEmpty({
          // Simpro POST expects PLAIN INTEGERS for Vendor / StorageDevice /
          // AssignedTo (NOT nested {ID:...} — different from the GET shape).
          Vendor: Number(supplierId),
          StorageDevice: args.storageDeviceId !== undefined ? Number(args.storageDeviceId) : 75,
          AssignedTo: assignment.matchedId,
          DateIssued: args.dateIssued,
          Reference: args.reference ?? `Job No. ${args.jobId}`,
          VendorNotes: args.vendorNotes,
          PrivateNotes: args.privateNotes,
        });
        const path = ctx.client.companyPath(ENDPOINTS.vendorOrders);
        const resolvedNote = noteLines.join("\n") + "\n\n";

        const blocked = writeGuard(ctx, {
          confirm: args.confirm,
          method: "POST",
          path,
          payload,
          summary: `Create PO to supplier #${supplierId} for job #${args.jobId}`,
        });
        if (blocked) {
          blocked.content[0].text = resolvedNote + blocked.content[0].text;
          return blocked;
        }
        const resp = await ctx.client.post<SimproVendorOrder>(path, payload);
        const result = formatRecord(
          `Created PO #${resp.ID ?? "?"} to ${resp.Vendor?.Name ?? "(supplier)"} attached to job #${args.jobId}.\n` +
          `Next: add line items with simpro_add_purchase_order_item using purchaseOrderId=${resp.ID}.`,
          resp, resp, true,
        );
        result.content[0].text = resolvedNote + result.content[0].text;
        return result;
      }),
  );

  // ---- add line item to PO ----
  // Verified live: POST /vendorOrders/{id}/catalogs/ with body shape:
  //   { Catalog: <int catalogId>, Price: <num>, Allocations: [{ Quantity: <int> }] }
  // Same Catalog can only appear ONCE per PO (duplicate-key constraint).
  registerTool(
    server,
    "simpro_add_purchase_order_item",
    "Add a line item to an existing Simpro purchase order. Requires confirm=true. The same catalog item can only appear once per PO — to change quantity, update the existing line.\n\nWORKFLOW for items from a supplier quote:\n  1. Call simpro_search_catalog with the part number to see if it already exists.\n  2. If found: use the returned catalogId here.\n  3. If NOT found: call simpro_create_catalog_item to add it (with name, partNo, tradePrice from the quote), then use the returned catalogId here. This is exactly how Goldman handles items that aren't in Simpro's catalog yet — they get added, then included on the PO.",
    () => (
    {
      confirm: confirmSchema,
      purchaseOrderId: idSchema,
      catalogId: idSchema.describe("Simpro catalog ID (the part). Find with simpro_search_catalog."),
      quantity: z.number().int().positive().describe("How many of this part to order."),
      price: z.number().nonnegative().optional()
        .describe("Unit price excluding tax. If omitted, Simpro uses the catalog's default trade price."),
      notes: z.string().optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Catalog: Number(args.catalogId),
          Price: args.price,
          Notes: args.notes,
          Allocations: [pruneEmpty({
            Quantity: args.quantity,
            Notes: args.notes,
          })],
        });
        const path = ctx.client.companyPath(
          ENDPOINTS.vendorOrderItems(args.purchaseOrderId),
        );
        const blocked = writeGuard(ctx, {
          confirm: args.confirm,
          method: "POST",
          path,
          payload,
          summary: `Add catalog #${args.catalogId} (qty ${args.quantity}) to PO #${args.purchaseOrderId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<{
          Catalog?: { ID?: number; PartNo?: string; Name?: string };
          Price?: number;
          Allocations?: Array<{ Quantity?: { Total?: number }; Total?: number }>;
        }>(path, payload);
        const lineTotal = resp.Allocations?.[0]?.Total;
        return formatRecord(
          `Added [${resp.Catalog?.PartNo ?? ""}] ${resp.Catalog?.Name ?? "(unnamed)"} ` +
          `to PO #${args.purchaseOrderId} — qty ${args.quantity}` +
          `${resp.Price !== undefined ? ` @ $${resp.Price}` : ""}` +
          `${lineTotal !== undefined ? ` = $${lineTotal} line total` : ""}.`,
          resp, resp, true,
        );
      }),
  );

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

  // ---- search vendor receipts (supplier invoices) ----
  registerTool(
    server,
    "simpro_search_supplier_invoices",
    "Search vendor receipts (supplier invoices / bills received). To find invoices FROM a supplier, pass `supplierId` if known, or `supplierName` to auto-resolve. The `query` field matches the supplier's invoice number (`VendorInvoiceNo`).",
    () => (
    {
      query: z.string().optional().describe("Free-text search against VendorInvoiceNo."),
      supplierName: z.string().optional()
        .describe("Supplier name (substring). Resolved to supplierId automatically."),
      supplierId: idSchema.optional()
        .describe("Exact Simpro supplier (vendor) ID."),
      dateFrom: isoDateSchema,
      dateTo: isoDateSchema,
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        let supplierId = args.supplierId;
        let resolvedNote = "";
        if (!supplierId && args.supplierName) {
          const lookup = await resolveSupplierByName(ctx, args.supplierName);
          if (!lookup.matchedId) return textResponse(lookup.note, true);
          supplierId = lookup.matchedId;
          resolvedNote = lookup.note + "\n\n";
        }
        const path = ctx.client.companyPath(ENDPOINTS.vendorReceipts);
        const pg = paginationQuery(ctx.config, args.page, args.pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields this tool's formatRow reads.
          columns: "ID,VendorInvoiceNo,Vendor,Total,DateIssued,DueDate,VendorOrder",
          ...buildKeywordFilter(args.query, "VendorInvoiceNo"),
          "Vendor.ID": supplierId,
          DateIssuedFrom: args.dateFrom,
          DateIssuedTo: args.dateTo,
        });
        const items = extractList(resp) as SimproVendorReceipt[];
        const result = formatList(
          items, undefined, pg.page, pg.pageSize,
          (vr) => {
            const total = typeof vr.Total === "number" ? vr.Total : vr.Total?.IncTax;
            return `#${vr.ID ?? "?"}` +
              `${vr.VendorInvoiceNo ? ` invoice ${vr.VendorInvoiceNo}` : ""}` +
              `${vr.Vendor?.Name ? ` | supplier: ${vr.Vendor.Name}` : ""}` +
              `${total !== undefined ? ` | total: ${total}` : ""}` +
              `${vr.DateIssued ? ` | issued: ${vr.DateIssued}` : ""}` +
              `${vr.DueDate ? ` | due: ${vr.DueDate}` : ""}` +
              `${vr.VendorOrder?.Reference ? ` | po-ref: ${vr.VendorOrder.Reference}` : ""}`;
          },
          resp, args.raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        return result;
      }),
  );

  // ---- list PO line items ----
  // Simpro keeps line items at /vendorOrders/{id}/catalogs/ (NOT /items/).
  // The list view returns Catalog{ID,PartNo,Name}, Price, DisplayOrder.
  // For QUANTITIES you need the per-item GET, which exposes Allocations[] —
  // each allocation has Quantity{Received,Total} + StorageDevice + AssignedTo
  // (the job/cost-centre this line was raised for).
  registerTool(
    server,
    "simpro_list_purchase_order_items",
    "List the line items on a Simpro purchase order. Returns each line's catalog ID, part number, name, and unit price. NOTE: quantities are not in this list view — call simpro_get_purchase_order_item for the full record including quantity ordered/received.",
    () => (
    {
      purchaseOrderId: idSchema,
      raw: rawFlagSchema,
    }
    ),
    () => async ({ purchaseOrderId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.vendorOrderItems(purchaseOrderId));
        const resp = await ctx.client.get<unknown>(path);
        const items = extractList(resp) as Array<{
          Catalog?: { ID?: number; PartNo?: string; Name?: string };
          Price?: number;
          DisplayOrder?: number;
          DueDate?: string;
          Notes?: string;
        }>;
        return formatList(
          items, undefined, 1, items.length,
          (it) =>
            `${it.DisplayOrder ?? "?"}. ` +
            `${it.Catalog?.PartNo ? `[${it.Catalog.PartNo}] ` : ""}` +
            `${it.Catalog?.Name ?? "(unnamed)"}` +
            `${it.Price !== undefined ? ` — unit $${it.Price}` : ""}` +
            `${it.Catalog?.ID !== undefined ? ` | catalogId: ${it.Catalog.ID}` : ""}` +
            `${it.Notes ? ` | notes: ${it.Notes}` : ""}`,
          resp, raw === true,
        );
      }),
  );

  // ---- get single PO line item (with quantity) ----
  registerTool(
    server,
    "simpro_get_purchase_order_item",
    "Get full detail of a single line item on a Simpro purchase order, including the Allocations array which holds Quantity (Received + Total), StorageDevice, and the job/cost-centre this line was raised for.",
    () => (
    {
      purchaseOrderId: idSchema,
      catalogId: idSchema.describe("The Catalog ID for the line — get this from simpro_list_purchase_order_items."),
      raw: rawFlagSchema,
    }
    ),
    () => async ({ purchaseOrderId, catalogId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.vendorOrderItemById(purchaseOrderId, catalogId));
        const resp = await ctx.client.get<{
          Catalog?: { ID?: number; PartNo?: string; Name?: string };
          Price?: number;
          Allocations?: Array<{
            Quantity?: { Received?: number; Total?: number };
            Total?: number;
            StorageDevice?: { ID?: number; Name?: string };
            AssignedTo?: { Job?: number; CostCenter?: { Name?: string } };
            Notes?: string;
          }>;
        }>(path);
        const totalQty = (resp.Allocations ?? []).reduce((sum, a) => sum + (a.Quantity?.Total ?? 0), 0);
        const totalReceived = (resp.Allocations ?? []).reduce((sum, a) => sum + (a.Quantity?.Received ?? 0), 0);
        const lineTotal = (resp.Allocations ?? []).reduce((sum, a) => sum + (a.Total ?? 0), 0);
        const summary =
          `Line item: ${resp.Catalog?.PartNo ? `[${resp.Catalog.PartNo}] ` : ""}${resp.Catalog?.Name ?? ""} ` +
          `— qty ordered: ${totalQty}, received: ${totalReceived}, unit $${resp.Price ?? "?"}, line total $${lineTotal}`;
        return formatRecord(summary, resp, resp, raw === true);
      }),
  );

  // ---- list supplier invoice line items ----
  registerTool(
    server,
    "simpro_list_supplier_invoice_items",
    "List the line items on a Simpro supplier invoice (vendor receipt). Requires both the parent purchaseOrderId and the supplierInvoiceId.",
    () => (
    {
      purchaseOrderId: idSchema.describe("Parent PO ID. Get this from simpro_search_supplier_invoices."),
      supplierInvoiceId: idSchema,
      raw: rawFlagSchema,
    }
    ),
    () => async ({ purchaseOrderId, supplierInvoiceId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.vendorReceiptItems(purchaseOrderId, supplierInvoiceId));
        const resp = await ctx.client.get<unknown>(path);
        const items = extractList(resp) as Array<{
          Catalog?: { ID?: number; PartNo?: string; Name?: string };
          Price?: number;
          DisplayOrder?: number;
        }>;
        return formatList(
          items, undefined, 1, items.length,
          (it) =>
            `${it.DisplayOrder ?? "?"}. ` +
            `${it.Catalog?.PartNo ? `[${it.Catalog.PartNo}] ` : ""}` +
            `${it.Catalog?.Name ?? "(unnamed)"}` +
            `${it.Price !== undefined ? ` — $${it.Price}` : ""}` +
            `${it.Catalog?.ID !== undefined ? ` | catalogId: ${it.Catalog.ID}` : ""}`,
          resp, raw === true,
        );
      }),
  );

  // ---- get supplier invoice ----
  // Simpro stores receipts NESTED under their vendor order, so the detail
  // path is /vendorOrders/{orderId}/receipts/{receiptId}. We auto-resolve
  // the order ID via a list-endpoint lookup so callers only need the
  // receipt ID.
  registerTool(
    server,
    "simpro_get_supplier_invoice",
    "Get full details of a Simpro vendor receipt (supplier invoice) by ID. Auto-resolves the parent vendor order.",
    () => (
    {
      supplierInvoiceId: idSchema,
      vendorOrderId: idSchema.optional()
        .describe("Optional: parent vendor order ID. If omitted, the tool resolves it automatically."),
      raw: rawFlagSchema,
    }
    ),
    () => async ({ supplierInvoiceId, vendorOrderId, raw }) =>
      safeRun(async () => {
        let orderId = vendorOrderId;
        if (!orderId) {
          const listPath = ctx.client.companyPath(ENDPOINTS.vendorReceipts);
          const lookup = await ctx.client.get<unknown>(listPath, {
            ID: supplierInvoiceId,
            pageSize: 1,
            columns: "ID,VendorOrder",
          });
          const items = extractList(lookup) as SimproVendorReceipt[];
          if (items.length === 0 || !items[0].VendorOrder?.ID) {
            return textResponse(
              `No supplier invoice found with ID ${supplierInvoiceId} (or its parent vendor order is missing).`,
              true,
            );
          }
          orderId = items[0].VendorOrder.ID as number;
        }
        const path = ctx.client.companyPath(
          ENDPOINTS.vendorReceiptByOrderAndId(orderId as string | number, supplierInvoiceId),
        );
        const resp = await ctx.client.get<SimproVendorReceipt>(path);
        return formatRecord(
          `Supplier Invoice #${resp.ID ?? supplierInvoiceId}${resp.VendorInvoiceNo ? ` (${resp.VendorInvoiceNo})` : ""}`,
          resp, resp, raw === true,
        );
      }),
  );
}
