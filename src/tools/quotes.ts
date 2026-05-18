import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { resolveCustomerByName } from "../utils/resolveCustomer.js";
import { applyClientFilters } from "../utils/listFilter.js";
import { idSchema, rawFlagSchema, rawPayloadSchema, confirmSchema, isoDateSchema } from "../utils/schemas.js";
import { pruneEmpty, stripHtml } from "../utils/sanitise.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, writeGuard } from "./_shared.js";
import { SimproQuote } from "../simpro/types.js";

export function registerQuoteTools(server: McpServer, ctx: ToolCtx) {
  // ---- 7. search ----
  server.tool(
    "simpro_search_quotes",
    "Search Simpro quotes. Filters by customer (pass `customerId`, or `customerName` to auto-resolve), `siteId`, and `status` (case-insensitive name) — applied client-side after fetching. The `query` field is a free-text search that ONLY matches inside the quote's Description (HTML body) — DO NOT put a customer name there, it will return nothing because Simpro descriptions rarely contain the customer's name.",
    {
      query: z.string().optional()
        .describe("Free-text search inside the quote's Description (HTML body). Use customerId/customerName to filter by customer."),
      customerName: z.string().optional()
        .describe("Customer name (substring). Tool resolves it to a customerId via simpro_search_customers. Prefer this over `query` when the user names a customer."),
      customerId: idSchema.optional()
        .describe("Exact Simpro customer ID. Most reliable filter when known."),
      siteId: idSchema.optional(),
      status: z.string().optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async (args) =>
      safeRun(async () => {
        // Resolve customerName → customerId if the caller gave a name but no id.
        let customerId = args.customerId;
        let resolvedNote = "";
        if (!customerId && args.customerName) {
          const lookup = await resolveCustomerByName(ctx.client, args.customerName);
          if (!lookup.matchedId) {
            return textResponse(lookup.note, true);
          }
          customerId = lookup.matchedId;
          resolvedNote = lookup.note + "\n\n";
        }
        const path = ctx.client.companyPath(ENDPOINTS.quotes);
        // Simpro list endpoints silently ignore unknown filter params, so
        // CustomerID/SiteID/Status never worked server-side. Fetch a large
        // page and filter in-process instead.
        const fetchSize = Math.min(ctx.config.SIMPRO_MAX_PAGE_SIZE, 250);
        const resp = await ctx.client.get<unknown>(path, {
          page: 1,
          pageSize: fetchSize,
          // Only the fields this tool's formatRow reads.
          columns: "ID,Description,Status,Customer,Site",
          ...buildKeywordFilter(args.query, "Description"),
        });
        const fetched = extractList(resp) as SimproQuote[];
        const filtered = applyClientFilters(
          fetched,
          { customerId, siteId: args.siteId, status: args.status },
          { dateField: "DateIssued" },
        );
        const limit = args.pageSize ?? ctx.config.SIMPRO_DEFAULT_PAGE_SIZE;
        const items = filtered.slice(0, limit);
        const anyFilter =
          customerId !== undefined || args.siteId !== undefined || args.status !== undefined;
        const result = formatList(
          items, undefined, 1, limit,
          (qt) => {
            const status = typeof qt.Status === "string" ? qt.Status : qt.Status?.Name ?? "";
            return `#${qt.ID ?? "?"} — ${stripHtml(qt.Description) || "(no description)"}` +
              `${qt.Customer?.Name ? ` | customer: ${qt.Customer.Name}` : ""}` +
              `${qt.Site?.Name ? ` | site: ${qt.Site.Name}` : ""}` +
              `${status ? ` | status: ${status}` : ""}`;
          },
          resp, args.raw === true,
        );
        if (resolvedNote) {
          result.content[0].text = resolvedNote + result.content[0].text;
        }
        if (fetched.length === fetchSize && anyFilter) {
          result.content[0].text +=
            `\n\n(Showing matches within the first ${fetchSize} records scanned. If an expected match is missing, narrow your search.)`;
        }
        return result;
      }),
  );

  // ---- 8. get ----
  server.tool(
    "simpro_get_quote",
    "Get full details of a Simpro quote by ID.",
    { quoteId: idSchema, raw: rawFlagSchema },
    async ({ quoteId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.quoteById(quoteId));
        const resp = await ctx.client.get<SimproQuote>(path);
        return formatRecord(`Quote #${resp.ID ?? quoteId}`, resp, resp, raw === true);
      }),
  );

  // ---- 15. create ----
  server.tool(
    "simpro_create_quote",
    "Create a new Simpro quote. Requires confirm=true. Use simpro_list_quote_types / simpro_list_cost_centres if your tenant requires those IDs.",
    {
      confirm: confirmSchema,
      customerId: idSchema,
      siteId: idSchema,
      description: z.string().min(1),
      quoteType: z.union([z.number(), z.string()]).optional(),
      dueDate: isoDateSchema,
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Customer: { ID: args.customerId },
          Site: { ID: args.siteId },
          Description: args.description,
          Type: args.quoteType !== undefined ? { ID: args.quoteType } : undefined,
          DueDate: args.dueDate,
        });
        const path = ctx.client.companyPath(ENDPOINTS.quotes);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create quote for customer #${args.customerId} at site #${args.siteId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<SimproQuote>(path, payload);
        return formatRecord(`Created quote #${resp.ID ?? "?"}.`, resp, resp, true);
      }),
  );

  // ---- 21. update ----
  server.tool(
    "simpro_update_quote",
    "Update a Simpro quote. Only provided fields are sent. Requires confirm=true.",
    {
      confirm: confirmSchema,
      quoteId: idSchema,
      description: z.string().optional(),
      status: z.union([z.number(), z.string()]).optional(),
      dueDate: isoDateSchema,
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Description: args.description,
          Status: args.status !== undefined ? { ID: args.status } : undefined,
          DueDate: args.dueDate,
        });
        if (Object.keys(payload).length === 0) return textResponse("No fields to update.", true);
        const path = ctx.client.companyPath(ENDPOINTS.quoteById(args.quoteId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update quote #${args.quoteId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<SimproQuote>(path, payload);
        return formatRecord(`Updated quote #${args.quoteId}.`, resp, resp, true);
      }),
  );

  // ---- 24. list quote statuses (sampled) ----
  server.tool(
    "simpro_list_quote_statuses",
    "List quote statuses observed across recent quotes (de-duplicated). Derived by sampling — recently-unused statuses may not appear.",
    {
      sampleSize: z.number().int().min(1).max(500).optional().describe("How many recent quotes to scan (default 200)."),
    },
    async ({ sampleSize }) =>
      safeRun(async () => {
        const size = sampleSize ?? 200;
        const path = ctx.client.companyPath(ENDPOINTS.quotes);
        const resp = await ctx.client.get<unknown>(path, {
          page: 1, pageSize: size, columns: "ID,Status",
        });
        const items = extractList(resp) as { Status?: { ID?: number; Name?: string; Color?: string } }[];
        const map = new Map<number, { ID: number; Name?: string; Color?: string }>();
        for (const q of items) {
          const s = q.Status;
          if (s?.ID !== undefined && !map.has(s.ID)) {
            map.set(s.ID, { ID: s.ID, Name: s.Name, Color: s.Color });
          }
        }
        const list = Array.from(map.values()).sort((a, b) => a.ID - b.ID);
        return formatList(list, undefined, 1, list.length,
          (s) => `#${s.ID} ${s.Name ?? "(unnamed)"}${s.Color ? ` (${s.Color})` : ""}`,
          { sampledFrom: items.length, uniqueStatuses: list.length, statuses: list },
          true);
      }),
  );

  // ---- 28. list quote types (sampled) ----
  server.tool(
    "simpro_list_quote_types",
    "List quote types observed across recent quotes (de-duplicated).",
    {
      sampleSize: z.number().int().min(1).max(500).optional().describe("How many recent quotes to scan (default 200)."),
    },
    async ({ sampleSize }) =>
      safeRun(async () => {
        const size = sampleSize ?? 200;
        const path = ctx.client.companyPath(ENDPOINTS.quotes);
        const resp = await ctx.client.get<unknown>(path, {
          page: 1, pageSize: size, columns: "ID,Type",
        });
        const items = extractList(resp) as { Type?: unknown }[];
        const seen = new Set<string>();
        for (const q of items) {
          if (q.Type !== undefined && q.Type !== null) seen.add(String(q.Type));
        }
        const list = Array.from(seen).sort();
        return formatList(list, undefined, 1, list.length,
          (t) => t,
          { sampledFrom: items.length, types: list },
          true);
      }),
  );
}
