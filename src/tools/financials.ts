// Financials read tools: customer payments, credit notes, recurring invoices.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { idSchema, rawFlagSchema, isoDateSchema } from "../utils/schemas.js";
import { resolveCustomerByName } from "../utils/resolveCustomer.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, registerTool } from "./_shared.js";

interface SimproCustomerPayment {
  ID?: number;
  Payment?: {
    PaymentMethod?: { ID?: number; Name?: string };
    Status?: string;
    DepositAccount?: string;
    Date?: string;
    FinanceCharge?: number;
    CheckNo?: string;
    Details?: string;
  };
  [key: string]: unknown;
}

interface SimproCreditNote {
  ID?: number;
  Customer?: { ID?: number; CompanyName?: string };
  InvoiceNo?: number;
  Stage?: string;
  Total?: { ExTax?: number; Tax?: number; IncTax?: number };
  [key: string]: unknown;
}

interface SimproRecurringInvoice {
  ID?: number;
  Customer?: { ID?: number; CompanyName?: string };
  [key: string]: unknown;
}

export function registerFinancialsTools(server: McpServer, ctx: ToolCtx) {
  // ---- search customer payments ----
  registerTool(
    server,
    "simpro_search_customer_payments",
    "Search Simpro customer payments (money received). Optionally filter by date range or customer.",
    () => (
    {
      customerName: z.string().optional().describe("Customer name — auto-resolved to customerId."),
      customerId: idSchema.optional(),
      dateFrom: isoDateSchema,
      dateTo: isoDateSchema,
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        let customerId = args.customerId;
        let resolvedNote = "";
        if (!customerId && args.customerName) {
          const lookup = await resolveCustomerByName(ctx.client, args.customerName);
          if (!lookup.matchedId) return textResponse(lookup.note, true);
          customerId = lookup.matchedId;
          resolvedNote = lookup.note + "\n\n";
        }
        const path = ctx.client.companyPath(ENDPOINTS.customerPayments);
        const pg = paginationQuery(ctx.config, args.page, args.pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields this tool's formatRow reads (Payment is a nested object).
          columns: "ID,Payment",
          "Customer.ID": customerId,
          DateFrom: args.dateFrom,
          DateTo: args.dateTo,
        });
        const items = extractList(resp) as SimproCustomerPayment[];
        const result = formatList(
          items, undefined, pg.page, pg.pageSize,
          (p) =>
            `#${p.ID ?? "?"}` +
            `${p.Payment?.Date ? ` | ${p.Payment.Date}` : ""}` +
            `${p.Payment?.PaymentMethod?.Name ? ` | method: ${p.Payment.PaymentMethod.Name}` : ""}` +
            `${p.Payment?.DepositAccount ? ` | account: ${p.Payment.DepositAccount}` : ""}` +
            `${p.Payment?.CheckNo ? ` | check: ${p.Payment.CheckNo}` : ""}`,
          resp, args.raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        return result;
      }),
  );

  // ---- search credit notes ----
  registerTool(
    server,
    "simpro_search_credit_notes",
    "Search Simpro credit notes. Optionally filter by customer or stage.",
    () => (
    {
      customerName: z.string().optional().describe("Customer name — auto-resolved."),
      customerId: idSchema.optional(),
      stage: z.string().optional().describe("e.g. 'Approved', 'Pending'."),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        let customerId = args.customerId;
        let resolvedNote = "";
        if (!customerId && args.customerName) {
          const lookup = await resolveCustomerByName(ctx.client, args.customerName);
          if (!lookup.matchedId) return textResponse(lookup.note, true);
          customerId = lookup.matchedId;
          resolvedNote = lookup.note + "\n\n";
        }
        const path = ctx.client.companyPath(ENDPOINTS.creditNotes);
        const pg = paginationQuery(ctx.config, args.page, args.pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields this tool's formatRow reads.
          columns: "ID,Customer,InvoiceNo,Total,Stage",
          "Customer.ID": customerId,
          Stage: args.stage,
        });
        const items = extractList(resp) as SimproCreditNote[];
        const result = formatList(
          items, undefined, pg.page, pg.pageSize,
          (cn) =>
            `#${cn.ID ?? "?"}` +
            `${cn.Customer?.CompanyName ? ` | customer: ${cn.Customer.CompanyName}` : ""}` +
            `${cn.InvoiceNo !== undefined ? ` | inv: ${cn.InvoiceNo}` : ""}` +
            `${cn.Total?.IncTax !== undefined ? ` | total: $${cn.Total.IncTax}` : ""}` +
            `${cn.Stage ? ` | stage: ${cn.Stage}` : ""}`,
          resp, args.raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        return result;
      }),
  );

  // ---- get credit note ----
  registerTool(
    server,
    "simpro_get_credit_note",
    "Get full detail of a Simpro credit note by ID.",
    () => (
    { creditNoteId: idSchema, raw: rawFlagSchema }
    ),
    () => async ({ creditNoteId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.creditNoteById(creditNoteId));
        const resp = await ctx.client.get<SimproCreditNote>(path);
        return formatRecord(`Credit Note #${resp.ID ?? creditNoteId}`, resp, resp, raw === true);
      }),
  );

  // ---- search recurring invoices ----
  registerTool(
    server,
    "simpro_search_recurring_invoices",
    "Search Simpro recurring invoice templates. Filter by customer if needed.",
    () => (
    {
      customerName: z.string().optional(),
      customerId: idSchema.optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        let customerId = args.customerId;
        let resolvedNote = "";
        if (!customerId && args.customerName) {
          const lookup = await resolveCustomerByName(ctx.client, args.customerName);
          if (!lookup.matchedId) return textResponse(lookup.note, true);
          customerId = lookup.matchedId;
          resolvedNote = lookup.note + "\n\n";
        }
        const path = ctx.client.companyPath(ENDPOINTS.recurringInvoices);
        const pg = paginationQuery(ctx.config, args.page, args.pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields this tool's formatRow reads.
          columns: "ID,Customer",
          "Customer.ID": customerId,
        });
        const items = extractList(resp) as SimproRecurringInvoice[];
        const result = formatList(
          items, undefined, pg.page, pg.pageSize,
          (ri) =>
            `#${ri.ID ?? "?"}` +
            `${ri.Customer?.CompanyName ? ` | customer: ${ri.Customer.CompanyName}` : ""}`,
          resp, args.raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        return result;
      }),
  );
}
