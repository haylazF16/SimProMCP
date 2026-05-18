import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { idSchema, rawFlagSchema, rawPayloadSchema, confirmSchema, addressSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, writeGuard } from "./_shared.js";
import { SimproCustomer } from "../simpro/types.js";

function customerLabel(c: SimproCustomer): string {
  if (c.CompanyName) return c.CompanyName;
  const personal = `${c.GivenName ?? ""} ${c.FamilyName ?? ""}`.trim();
  return personal || "(unnamed)";
}

/**
 * Resolve a customer's typed sub-path. Simpro returns 404 for bare
 * /customers/{id}; we try /customers/companies/{id} first, then fall back
 * to /customers/individuals/{id} on 404. Returns the path that succeeded
 * (so update tools can PATCH the same path).
 */
async function resolveCustomerPath(
  ctx: ToolCtx,
  customerId: string | number,
  hint?: "company" | "individual",
): Promise<{ path: string; record: SimproCustomer; type: "company" | "individual" }> {
  const tryOrder: ("company" | "individual")[] =
    hint === "individual" ? ["individual", "company"] : ["company", "individual"];
  let lastErr: unknown;
  for (const t of tryOrder) {
    const path = ctx.client.companyPath(
      t === "company"
        ? ENDPOINTS.customerCompanyById(customerId)
        : ENDPOINTS.customerIndividualById(customerId),
    );
    try {
      const record = await ctx.client.get<SimproCustomer>(path);
      return { path, record, type: t };
    } catch (err) {
      lastErr = err;
      // Only keep trying if it's a 404. Anything else (401/403/timeout) -> rethrow.
      const status = (err as { status?: number })?.status;
      if (status !== 404) throw err;
    }
  }
  throw lastErr;
}

export function registerCustomerTools(server: McpServer, ctx: ToolCtx) {
  // ---- 1. search ----
  server.tool(
    "simpro_search_customers",
    "Search customers in Simpro by name, company name, email, phone, or keyword. Returns a paginated list.",
    {
      query: z.string().optional().describe("Free-text search keyword."),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async ({ query, page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.customers);
        const pg = paginationQuery(ctx.config, page, pageSize);
        // Simpro filters by column name with %wildcards%; CompanyName is the most
        // useful default for free-text customer search (covers both Company and
        // Individual records since CompanyName is populated for individuals as
        // "FAMILY, GIVEN" too).
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields customerLabel() + formatRow read.
          columns: "ID,CompanyName,GivenName,FamilyName,Email,Phone,Type,Archived",
          ...buildKeywordFilter(query, "CompanyName"),
        });
        const items = extractList(resp) as SimproCustomer[];
        return formatList(
          items, undefined, pg.page, pg.pageSize,
          (c) =>
            `#${c.ID ?? "?"} ${customerLabel(c)}` +
            `${c.Email ? ` <${c.Email}>` : ""}` +
            `${c.Phone ? ` tel:${c.Phone}` : ""}` +
            `${c.Type ? ` [${c.Type}]` : ""}` +
            `${c.Archived ? " [archived]" : ""}`,
          resp,
          raw === true,
        );
      }),
  );

  // ---- 2. get ----
  server.tool(
    "simpro_get_customer",
    "Get full details of a single Simpro customer by ID.",
    {
      customerId: idSchema,
      customerType: z.enum(["company", "individual"]).optional()
        .describe("Optional hint to skip auto-detection. Defaults to trying company then individual."),
      raw: rawFlagSchema,
    },
    async ({ customerId, customerType, raw }) =>
      safeRun(async () => {
        const { record, type } = await resolveCustomerPath(ctx, customerId, customerType);
        return formatRecord(
          `Customer #${record.ID ?? customerId} (${type}): ${customerLabel(record)}`,
          record, record, raw === true,
        );
      }),
  );

  // ---- 12. create ----
  server.tool(
    "simpro_create_customer",
    "Create a new customer in Simpro. Requires confirm=true. Honors SIMPRO_ENABLE_WRITE_TOOLS and SIMPRO_DRY_RUN.",
    {
      confirm: confirmSchema,
      customerType: z.enum(["company", "individual"]).optional()
        .describe("Pick which Simpro endpoint family to use. Defaults to 'company' if companyName is provided, else 'individual'."),
      companyName: z.string().optional(),
      givenName: z.string().optional(),
      familyName: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      mobile: z.string().optional(),
      address: addressSchema,
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
      safeRun(async () => {
        const inferredType =
          args.customerType ?? (args.companyName ? "company" : (args.givenName || args.familyName) ? "individual" : undefined);
        if (!args.rawPayload && !inferredType) {
          return textResponse(
            "Missing fields: provide either `companyName` (company) or `givenName`/`familyName` (individual), or pass a `rawPayload` matching Simpro's customer schema.",
            true,
          );
        }
        const payload = args.rawPayload
          ? args.rawPayload
          : pruneEmpty({
              CompanyName: args.companyName,
              GivenName: args.givenName,
              FamilyName: args.familyName,
              Email: args.email,
              Phone: args.phone,
              CellPhone: args.mobile,
              Address: args.address,
            });
        const subPath =
          inferredType === "company" ? ENDPOINTS.customersCompanies
          : inferredType === "individual" ? ENDPOINTS.customersIndividuals
          : ENDPOINTS.customers;
        const path = ctx.client.companyPath(subPath);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create ${inferredType ?? "customer"} in Simpro`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<SimproCustomer>(path, payload);
        return formatRecord(`Created customer #${resp.ID ?? "?"} (${customerLabel(resp)}).`, resp, resp, true);
      }),
  );

  // ---- 18. update ----
  server.tool(
    "simpro_update_customer",
    "Update an existing Simpro customer. Only provided fields are sent (PATCH semantics). Requires confirm=true.",
    {
      confirm: confirmSchema,
      customerId: idSchema,
      customerType: z.enum(["company", "individual"]).optional()
        .describe("Optional hint to skip auto-detection. Defaults to trying company then individual."),
      companyName: z.string().optional(),
      givenName: z.string().optional(),
      familyName: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      mobile: z.string().optional(),
      address: addressSchema,
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload
          ? args.rawPayload
          : pruneEmpty({
              CompanyName: args.companyName,
              GivenName: args.givenName,
              FamilyName: args.familyName,
              Email: args.email,
              Phone: args.phone,
              CellPhone: args.mobile,
              Address: args.address,
            });
        if (Object.keys(payload).length === 0) return textResponse("No fields provided to update.", true);
        // Resolve the typed customer path. In dry-run we still need this to
        // build an accurate planned PATCH path, so we run the lookup first.
        const { path } = await resolveCustomerPath(ctx, args.customerId, args.customerType);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update customer #${args.customerId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<SimproCustomer>(path, payload);
        return formatRecord(`Updated customer #${args.customerId}.`, resp, resp, true);
      }),
  );
}
