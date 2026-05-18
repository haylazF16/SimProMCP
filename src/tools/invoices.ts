import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { resolveCustomerByName } from "../utils/resolveCustomer.js";
import { applyClientFilters } from "../utils/listFilter.js";
import { idSchema, rawFlagSchema, isoDateSchema } from "../utils/schemas.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx } from "./_shared.js";
import { SimproInvoice } from "../simpro/types.js";

export function registerInvoiceTools(server: McpServer, ctx: ToolCtx) {
  // ---- 9. search ----
  server.tool(
    "simpro_search_invoices",
    "Search Simpro invoices. Filters by customer (pass `customerId` or `customerName`, auto-resolved), `status` (case-insensitive name), and `dateFrom`/`dateTo` (issue date, inclusive, yyyy-mm-dd) — applied client-side after fetching. The `query` field ONLY matches the InvoiceNo, NOT the customer name.",
    {
      query: z.string().optional()
        .describe("Free-text search against InvoiceNo. Use customerId/customerName for customer-based filtering."),
      customerName: z.string().optional()
        .describe("Customer name (substring). Resolved to customerId. Prefer this over `query` when the user names a customer."),
      customerId: idSchema.optional()
        .describe("Exact Simpro customer ID."),
      status: z.string().optional(),
      dateFrom: isoDateSchema,
      dateTo: isoDateSchema,
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async (args) =>
      safeRun(async () => {
        let customerId = args.customerId;
        let resolvedNote = "";
        if (!customerId && args.customerName) {
          const lookup = await resolveCustomerByName(ctx.client, args.customerName);
          if (!lookup.matchedId) return textResponse(lookup.note, true);
          customerId = lookup.matchedId;
          resolvedNote = lookup.note + "\n\n";
        }
        const path = ctx.client.companyPath(ENDPOINTS.invoices);
        // Simpro list endpoints silently ignore unknown filter params, so
        // CustomerID/Status/DateIssued* never worked server-side. Fetch a
        // large page and filter in-process instead.
        // Filtered search needs a wide, NEWEST-first scan window. Simpro v1.0
        // list endpoints default to oldest-first by ID, so without orderby the
        // 100-record default would only ever cover the most ancient records and
        // miss the customer's recent invoices. 250 is the agreed scan cap.
        const fetchSize = 250;
        const resp = await ctx.client.get<unknown>(path, {
          page: 1,
          pageSize: fetchSize,
          orderby: "-ID",
          // Only the fields this tool's formatRow reads.
          columns: "ID,Customer,Total,Status,DateIssued",
          ...buildKeywordFilter(args.query, "InvoiceNo"),
        });
        const fetched = extractList(resp) as SimproInvoice[];
        const filtered = applyClientFilters(
          fetched,
          { customerId, status: args.status, dateFrom: args.dateFrom, dateTo: args.dateTo },
          { dateField: "DateIssued" },
        );
        const limit = args.pageSize ?? ctx.config.SIMPRO_DEFAULT_PAGE_SIZE;
        const items = filtered.slice(0, limit);
        const anyFilter =
          customerId !== undefined || args.status !== undefined ||
          args.dateFrom !== undefined || args.dateTo !== undefined;
        const result = formatList(
          items, undefined, 1, limit,
          (inv) => {
            const status = typeof inv.Status === "string" ? inv.Status : inv.Status?.Name ?? "";
            const total = typeof inv.Total === "number" ? inv.Total : inv.Total?.IncTax;
            return `#${inv.ID ?? "?"}` +
              `${inv.Customer?.Name ? ` | customer: ${inv.Customer.Name}` : ""}` +
              `${total !== undefined ? ` | total: ${total}` : ""}` +
              `${status ? ` | status: ${status}` : ""}` +
              `${inv.DateIssued ? ` | issued: ${inv.DateIssued}` : ""}`;
          },
          resp, args.raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        if (fetched.length === fetchSize && anyFilter) {
          result.content[0].text +=
            `\n\n(Showing matches within the first ${fetchSize} records scanned. If an expected match is missing, narrow your search.)`;
        }
        return result;
      }),
  );

  // ---- 10. get ----
  server.tool(
    "simpro_get_invoice",
    "Get full details of a Simpro invoice by ID.",
    { invoiceId: idSchema, raw: rawFlagSchema },
    async ({ invoiceId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.invoiceById(invoiceId));
        const resp = await ctx.client.get<SimproInvoice>(path);
        return formatRecord(`Invoice #${resp.ID ?? invoiceId}`, resp, resp, raw === true);
      }),
  );
}
