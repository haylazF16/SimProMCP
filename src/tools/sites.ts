import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { resolveCustomerByName } from "../utils/resolveCustomer.js";
import { idSchema, rawFlagSchema, rawPayloadSchema, confirmSchema, addressSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, writeGuard } from "./_shared.js";
import { SimproSite } from "../simpro/types.js";

export function registerSiteTools(server: McpServer, ctx: ToolCtx) {
  // ---- 3. search ----
  server.tool(
    "simpro_search_sites",
    "Search Simpro sites. `query` matches the site Name. To find sites BELONGING to a customer, pass `customerId` or `customerName` (auto-resolved).",
    {
      query: z.string().optional()
        .describe("Free-text search against the site's Name."),
      customerName: z.string().optional()
        .describe("Customer name (substring). Resolved to customerId via simpro_search_customers."),
      customerId: idSchema.optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async ({ query, customerName, customerId, page, pageSize, raw }) =>
      safeRun(async () => {
        let effectiveCustomerId = customerId;
        let resolvedNote = "";
        if (!effectiveCustomerId && customerName) {
          const lookup = await resolveCustomerByName(ctx.client, customerName);
          if (!lookup.matchedId) return textResponse(lookup.note, true);
          effectiveCustomerId = lookup.matchedId;
          resolvedNote = lookup.note + "\n\n";
        }
        const path = ctx.client.companyPath(ENDPOINTS.sites);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields this tool's formatRow reads.
          columns: "ID,Name,Address,Customer",
          ...buildKeywordFilter(query, "Name"),
          CustomerID: effectiveCustomerId,
        });
        const items = extractList(resp) as SimproSite[];
        const result = formatList(
          items,
          undefined,
          pg.page,
          pg.pageSize,
          (s) => {
            const addr = s.Address;
            const addrStr = addr
              ? [addr.Address, addr.City, addr.State, addr.PostalCode].filter(Boolean).join(", ")
              : "";
            return `#${s.ID ?? "?"} ${s.Name ?? "(unnamed)"}${addrStr ? ` — ${addrStr}` : ""}` +
              `${s.Customer?.Name ? ` [customer: ${s.Customer.Name}]` : ""}`;
          },
          resp,
          raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        return result;
      }),
  );

  // ---- 4. get ----
  server.tool(
    "simpro_get_site",
    "Get full details of a Simpro site by ID.",
    { siteId: idSchema, raw: rawFlagSchema },
    async ({ siteId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.siteById(siteId));
        const resp = await ctx.client.get<SimproSite>(path);
        return formatRecord(`Site #${resp.ID ?? siteId}: ${resp.Name ?? "(unnamed)"}`, resp, resp, raw === true);
      }),
  );

  // ---- 13. create ----
  server.tool(
    "simpro_create_site",
    "Create a new site in Simpro under a customer. Requires confirm=true.",
    {
      confirm: confirmSchema,
      customerId: idSchema,
      name: z.string().min(1),
      address: addressSchema,
      contactName: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Name: args.name,
          Address: args.address,
          Customers: [{ Customer: { ID: args.customerId } }],
          PrimaryContact: pruneEmpty({
            GivenName: args.contactName,
            Email: args.email,
            Phone: args.phone,
          }),
        });
        const path = ctx.client.companyPath(ENDPOINTS.sites);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create site "${args.name}" for customer #${args.customerId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<SimproSite>(path, payload);
        return formatRecord(`Created site #${resp.ID ?? "?"}.`, resp, resp, true);
      }),
  );

  // ---- 19. update ----
  server.tool(
    "simpro_update_site",
    "Update a Simpro site. Only provided fields are sent. Requires confirm=true.",
    {
      confirm: confirmSchema,
      siteId: idSchema,
      name: z.string().optional(),
      address: addressSchema,
      contactName: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Name: args.name,
          Address: args.address,
          PrimaryContact: pruneEmpty({
            GivenName: args.contactName,
            Email: args.email,
            Phone: args.phone,
          }),
        });
        if (Object.keys(payload).length === 0) return textResponse("No fields to update.", true);
        const path = ctx.client.companyPath(ENDPOINTS.siteById(args.siteId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update site #${args.siteId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<SimproSite>(path, payload);
        return formatRecord(`Updated site #${args.siteId}.`, resp, resp, true);
      }),
  );
}
