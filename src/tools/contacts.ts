// Contacts and leads — CRM-side records.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { idSchema, rawFlagSchema, confirmSchema, rawPayloadSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { resolveCustomerByName } from "../utils/resolveCustomer.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, writeGuard, registerTool } from "./_shared.js";

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
  registerTool(
    server,
    "simpro_search_contacts",
    "Search Simpro contacts (people attached to customers/sites). Use `query` to match GivenName/FamilyName.",
    () => (
    {
      query: z.string().optional().describe("Free-text search against contact's GivenName."),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    }
    ),
    () => async ({ query, page, pageSize, raw }) =>
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
  registerTool(
    server,
    "simpro_get_contact",
    "Get full detail of a Simpro contact by ID.",
    () => (
    { contactId: idSchema, raw: rawFlagSchema }
    ),
    () => async ({ contactId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.contactById(contactId));
        const resp = await ctx.client.get<SimproContact>(path);
        const name = `${resp.GivenName ?? ""} ${resp.FamilyName ?? ""}`.trim() || "(unnamed)";
        return formatRecord(`Contact #${resp.ID ?? contactId}: ${name}`, resp, resp, raw === true);
      }),
  );

  // ---- search leads ----
  registerTool(
    server,
    "simpro_search_leads",
    "Search Simpro sales leads. Optionally filter by customerName/customerId. NOTE: this tenant may have zero leads if the leads module isn't actively used.",
    () => (
    {
      query: z.string().optional().describe("Free-text against lead Description."),
      customerName: z.string().optional().describe("Customer name (substring) — auto-resolved to customerId."),
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
  registerTool(
    server,
    "simpro_get_lead",
    "Get full detail of a Simpro sales lead by ID.",
    () => (
    { leadId: idSchema, raw: rawFlagSchema }
    ),
    () => async ({ leadId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.leadById(leadId));
        const resp = await ctx.client.get<SimproLead>(path);
        return formatRecord(`Lead #${resp.ID ?? leadId}`, resp, resp, raw === true);
      }),
  );

  // ---- create contact ----
  registerTool(
    server,
    "simpro_create_contact",
    "Create a new contact (person attached to customers/sites) in Simpro. Requires confirm=true. Honors SIMPRO_ENABLE_WRITE_TOOLS and SIMPRO_DRY_RUN.",
    () => (
    {
      confirm: confirmSchema,
      givenName: z.string().min(1).describe("First name."),
      familyName: z.string().optional().describe("Last name."),
      email: z.string().email().optional(),
      workPhone: z.string().optional(),
      cellPhone: z.string().optional().describe("Mobile number."),
      position: z.string().optional().describe("Job title / role."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          GivenName: args.givenName,
          FamilyName: args.familyName,
          Email: args.email,
          WorkPhone: args.workPhone,
          CellPhone: args.cellPhone,
          Position: args.position,
        });
        const path = ctx.client.companyPath(ENDPOINTS.contacts);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create contact "${[args.givenName, args.familyName].filter(Boolean).join(" ")}" in Simpro`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<SimproContact>(path, payload);
        return formatRecord(`Created contact #${resp.ID ?? "?"}.`, resp, resp, true);
      }),
  );

  // ---- update contact ----
  registerTool(
    server,
    "simpro_update_contact",
    "Update an existing Simpro contact (partial update — only provided fields change). Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      contactId: idSchema,
      givenName: z.string().optional(),
      familyName: z.string().optional(),
      email: z.string().email().optional(),
      workPhone: z.string().optional(),
      cellPhone: z.string().optional(),
      position: z.string().optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          GivenName: args.givenName,
          FamilyName: args.familyName,
          Email: args.email,
          WorkPhone: args.workPhone,
          CellPhone: args.cellPhone,
          Position: args.position,
        });
        if (Object.keys(payload).length === 0) {
          return textResponse("No fields to update — provide at least one field or rawPayload.", true);
        }
        const path = ctx.client.companyPath(ENDPOINTS.contactById(args.contactId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update contact #${args.contactId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<SimproContact>(path, payload);
        return formatRecord(`Updated contact #${args.contactId}.`, resp, resp, true);
      }),
  );

  // ---- create lead ----
  registerTool(
    server,
    "simpro_create_lead",
    "Create a new sales lead in Simpro. Requires confirm=true. Look up IDs first: customer via simpro_search_customers, site via simpro_search_sites, salesperson via simpro_list_staff. Tenant-specific required fields can be supplied with rawPayload.",
    () => (
    {
      confirm: confirmSchema,
      leadName: z.string().min(1).describe("Short name/description of the lead."),
      customerId: idSchema.optional().describe("Simpro customer ID."),
      siteId: idSchema.optional().describe("Simpro site ID."),
      salespersonId: idSchema.optional().describe("Staff ID of the salesperson."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          LeadName: args.leadName,
          Customer: args.customerId,
          Site: args.siteId,
          Salesperson: args.salespersonId,
        });
        const path = ctx.client.companyPath(ENDPOINTS.leads);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create lead "${args.leadName}" in Simpro`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<SimproLead>(path, payload);
        return formatRecord(`Created lead #${resp.ID ?? "?"}.`, resp, resp, true);
      }),
  );

  // ---- update lead ----
  registerTool(
    server,
    "simpro_update_lead",
    "Update an existing Simpro lead (partial update — only provided fields change). Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      leadId: idSchema,
      leadName: z.string().optional(),
      customerId: idSchema.optional(),
      siteId: idSchema.optional(),
      salespersonId: idSchema.optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          LeadName: args.leadName,
          Customer: args.customerId,
          Site: args.siteId,
          Salesperson: args.salespersonId,
        });
        if (Object.keys(payload).length === 0) {
          return textResponse("No fields to update — provide at least one field or rawPayload.", true);
        }
        const path = ctx.client.companyPath(ENDPOINTS.leadById(args.leadId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update lead #${args.leadId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<SimproLead>(path, payload);
        return formatRecord(`Updated lead #${args.leadId}.`, resp, resp, true);
      }),
  );
}
