import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { resolveCustomerByName } from "../utils/resolveCustomer.js";
import { idSchema, rawFlagSchema, isoDateSchema } from "../utils/schemas.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx } from "./_shared.js";
import { SimproInvoice } from "../simpro/types.js";

export function registerInvoiceTools(server: McpServer, ctx: ToolCtx) {
  // ---- 9. search ----
  server.tool(
    "simpro_search_invoices",
    "Search Simpro invoices. To find invoices FOR a customer, pass `customerId` or `customerName` (auto-resolved). The `query` field ONLY matches the InvoiceNo, NOT the customer name.",
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
        const pg = paginationQuery(ctx.config, args.page, args.pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          ...buildKeywordFilter(args.query, "InvoiceNo"),
          CustomerID: customerId,
          Status: args.status,
          DateIssuedFrom: args.dateFrom,
          DateIssuedTo: args.dateTo,
        });
        const items = extractList(resp) as SimproInvoice[];
        const result = formatList(
          items, undefined, pg.page, pg.pageSize,
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
