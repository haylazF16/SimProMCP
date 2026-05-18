// Contacts and leads — CRM-side records.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { idSchema, rawFlagSchema } from "../utils/schemas.js";
import { resolveCustomerByName } from "../utils/resolveCustomer.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx } from "./_shared.js";

interface SimproContact {
  ID?: number;
  GivenName?: string;
  FamilyName?: string;
  Email?: string;
  WorkPhone?: string;
  CellPhone?: string;
  Position?: string;
  [key: string]: unknown;
}

interface SimproLead {
  ID?: number;
  Description?: string;
  Status?: { ID?: number; Name?: string } | string;
  Customer?: { ID?: number; CompanyName?: string };
  [key: string]: unknown;
}

export function registerContactTools(server: McpServer, ctx: ToolCtx) {
  // ---- search contacts ----
  server.tool(
    "simpro_search_contacts",
    "Search Simpro contacts (people attached to customers/sites). Use `query` to match GivenName/FamilyName.",
    {
      query: z.string().optional().describe("Free-text search against contact's GivenName."),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async ({ query, page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.contacts);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields this tool's formatRow reads.
          columns: "ID,GivenName,FamilyName,Email,WorkPhone,Position",
          ...buildKeywordFilter(query, "GivenName"),
        });
        const items = extractList(resp) as SimproContact[];
        return formatList(
          items, undefined, pg.page, pg.pageSize,
          (c) => {
            const name = `${c.GivenName ?? ""} ${c.FamilyName ?? ""}`.trim() || "(unnamed)";
            return `#${c.ID ?? "?"} ${name}` +
              `${c.Position ? ` (${c.Position})` : ""}` +
              `${c.Email ? ` <${c.Email}>` : ""}` +
              `${c.WorkPhone ? ` tel:${c.WorkPhone}` : ""}`;
          },
          resp, raw === true,
        );
      }),
  );

  // ---- get contact ----
  server.tool(
    "simpro_get_contact",
    "Get full detail of a Simpro contact by ID.",
    { contactId: idSchema, raw: rawFlagSchema },
    async ({ contactId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.contactById(contactId));
        const resp = await ctx.client.get<SimproContact>(path);
        const name = `${resp.GivenName ?? ""} ${resp.FamilyName ?? ""}`.trim() || "(unnamed)";
        return formatRecord(`Contact #${resp.ID ?? contactId}: ${name}`, resp, resp, raw === true);
      }),
  );

  // ---- search leads ----
  server.tool(
    "simpro_search_leads",
    "Search Simpro sales leads. Optionally filter by customerName/customerId. NOTE: this tenant may have zero leads if the leads module isn't actively used.",
    {
      query: z.string().optional().describe("Free-text against lead Description."),
      customerName: z.string().optional().describe("Customer name (substring) — auto-resolved to customerId."),
      customerId: idSchema.optional(),
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
        const path = ctx.client.companyPath(ENDPOINTS.leads);
        const pg = paginationQuery(ctx.config, args.page, args.pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields this tool's formatRow reads.
          columns: "ID,Description,Status,Customer",
          ...buildKeywordFilter(args.query, "Description"),
          "Customer.ID": customerId,
        });
        const items = extractList(resp) as SimproLead[];
        const result = formatList(
          items, undefined, pg.page, pg.pageSize,
          (l) => {
            const status = typeof l.Status === "string" ? l.Status : l.Status?.Name ?? "";
            return `#${l.ID ?? "?"}` +
              `${l.Description ? ` — ${l.Description.slice(0, 80)}` : ""}` +
              `${l.Customer?.CompanyName ? ` | customer: ${l.Customer.CompanyName}` : ""}` +
              `${status ? ` | status: ${status}` : ""}`;
          },
          resp, args.raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        return result;
      }),
  );

  // ---- get lead ----
  server.tool(
    "simpro_get_lead",
    "Get full detail of a Simpro sales lead by ID.",
    { leadId: idSchema, raw: rawFlagSchema },
    async ({ leadId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.leadById(leadId));
        const resp = await ctx.client.get<SimproLead>(path);
        return formatRecord(`Lead #${resp.ID ?? leadId}`, resp, resp, raw === true);
      }),
  );
}
