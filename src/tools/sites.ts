import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { resolveCustomerByName } from "../utils/resolveCustomer.js";
import { idSchema, rawFlagSchema, rawPayloadSchema, confirmSchema, addressSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, writeGuard, registerTool } from "./_shared.js";
import { SimproSite } from "../simpro/types.js";

// Sites can reference customers in several shapes depending on tenant/endpoint:
// a singular `Customer` ref, a flat `CustomerID`, or a `Customers[]` array of
// `{ Customer: {...} }` (the shape used when creating a site). These helpers
// read all of them so customer filtering/display work regardless of shape, and
// tolerate either `Name` or `CompanyName` on the customer ref.
type SiteCustomerRef = { ID?: number | string; Name?: string; CompanyName?: string };

function siteCustomerRefs(site: SimproSite): SiteCustomerRef[] {
  const refs: SiteCustomerRef[] = [];
  if (site.Customer && typeof site.Customer === "object") {
    refs.push(site.Customer as SiteCustomerRef);
  }
  if (site.CustomerID != null) refs.push({ ID: site.CustomerID as number | string });
  const many = site.Customers;
  if (Array.isArray(many)) {
    for (const entry of many) {
      if (entry && typeof entry === "object") {
        const c = (entry as { Customer?: unknown }).Customer ?? entry;
        if (c && typeof c === "object") refs.push(c as SiteCustomerRef);
      }
    }
  }
  return refs;
}

function siteBelongsToCustomer(site: SimproSite, customerId: number | string): boolean {
  const want = String(customerId);
  return siteCustomerRefs(site).some((r) => r.ID != null && String(r.ID) === want);
}

function siteCustomerName(site: SimproSite): string | undefined {
  for (const r of siteCustomerRefs(site)) {
    const name = r.Name ?? r.CompanyName;
    if (typeof name === "string" && name) return name;
  }
  return undefined;
}

export function registerSiteTools(server: McpServer, ctx: ToolCtx) {
  // ---- 3. search ----
  registerTool(
    server,
    "simpro_search_sites",
    "Search Simpro sites. `query` matches the site Name. To find sites BELONGING to a customer, pass `customerId` or `customerName` (auto-resolved).",
    () => (
    {
      query: z.string().optional()
        .describe("Free-text search against the site's Name."),
      customerName: z.string().optional()
        .describe("Customer name (substring). Resolved to customerId via simpro_search_customers."),
      customerId: idSchema.optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    }
    ),
    () => async ({ query, customerName, customerId, page, pageSize, raw }) =>
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
        // NOTE: no columns= selector. Simpro's /sites/ list endpoint rejects
        // "Customer" as a selectable column ("Invalid columns found", observed
        // 2026-06-05) — same class as JobNumber on /jobs/ (see fa7959d). We
        // also do NOT pass CustomerID as a query param: Simpro list endpoints
        // silently ignore unknown filter params, so customer filtering happens
        // client-side after a newest-first scan window (mirrors search_jobs).
        // Pagination is client-side too (a server-side page of the unfiltered
        // list is meaningless once rows are filtered out), so the wide scan
        // window is only fetched when the customer filter is active; plain
        // listing fetches just enough rows to serve the requested page.
        const limit = pageSize ?? ctx.config.SIMPRO_DEFAULT_PAGE_SIZE;
        const pageNum = page ?? 1;
        const wantCustomerId = effectiveCustomerId;
        const filterActive = wantCustomerId !== undefined;
        const scanCap = 250;
        const fetchSize = filterActive ? scanCap : Math.min(pageNum * limit, scanCap);
        const resp = await ctx.client.get<unknown>(path, {
          page: 1,
          pageSize: fetchSize,
          orderby: "-ID",
          ...buildKeywordFilter(query, "Name"),
        });
        const fetched = extractList(resp) as SimproSite[];
        const filtered = filterActive
          ? fetched.filter((s) => siteBelongsToCustomer(s, wantCustomerId))
          : fetched;
        const start = (pageNum - 1) * limit;
        const items = filtered.slice(start, start + limit);
        const result = formatList(
          items,
          undefined,
          pageNum,
          limit,
          (s) => {
            const addr = s.Address;
            const addrStr = addr
              ? [addr.Address, addr.City, addr.State, addr.PostalCode].filter(Boolean).join(", ")
              : "";
            const custName = siteCustomerName(s);
            return `#${s.ID ?? "?"} ${s.Name ?? "(unnamed)"}${addrStr ? ` — ${addrStr}` : ""}` +
              `${custName ? ` [customer: ${custName}]` : ""}`;
          },
          resp,
          raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        // Warn only when the scan window itself is exhausted: either a
        // client-side filter scanned a full window, or the requested page
        // extends past what one window can serve. A full fetch on an
        // unfiltered early page just means more pages exist — that's normal.
        if (fetched.length === scanCap && (filterActive || pageNum * limit > scanCap)) {
          result.content[0].text +=
            `\n\n(Showing matches within the first ${scanCap} sites scanned. If an expected match is missing, narrow your search.)`;
        }
        return result;
      }),
  );

  // ---- 4. get ----
  registerTool(
    server,
    "simpro_get_site",
    "Get full details of a Simpro site by ID.",
    () => (
    { siteId: idSchema, raw: rawFlagSchema }
    ),
    () => async ({ siteId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.siteById(siteId));
        const resp = await ctx.client.get<SimproSite>(path);
        return formatRecord(`Site #${resp.ID ?? siteId}: ${resp.Name ?? "(unnamed)"}`, resp, resp, raw === true);
      }),
  );

  // ---- 13. create ----
  registerTool(
    server,
    "simpro_create_site",
    "Create a new site in Simpro under a customer. Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      customerId: idSchema,
      name: z.string().min(1),
      address: addressSchema,
      contactName: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
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
  registerTool(
    server,
    "simpro_update_site",
    "Update a Simpro site. Only provided fields are sent. Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      siteId: idSchema,
      name: z.string().optional(),
      address: addressSchema,
      contactName: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
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
