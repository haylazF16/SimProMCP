import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { resolveCustomerByName } from "../utils/resolveCustomer.js";
import { stripHtml } from "../utils/sanitise.js";
import { idSchema, rawFlagSchema, rawPayloadSchema, confirmSchema, isoDateSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, writeGuard } from "./_shared.js";
import { SimproJob } from "../simpro/types.js";

export function registerJobTools(server: McpServer, ctx: ToolCtx) {
  // ---- 5. search ----
  server.tool(
    "simpro_search_jobs",
    "Search Simpro jobs. To find jobs FOR a customer, pass `customerId` if known, or `customerName` to auto-resolve. The `query` field ONLY matches inside the job's Description (HTML body) — DO NOT put a customer name there.",
    {
      query: z.string().optional()
        .describe("Free-text search inside the job's Description (HTML body). Use customerId/customerName for customer-based filtering."),
      customerName: z.string().optional()
        .describe("Customer name (substring). Resolved to customerId via simpro_search_customers. Prefer this over `query` when the user names a customer."),
      customerId: idSchema.optional()
        .describe("Exact Simpro customer ID. Most reliable filter when known."),
      siteId: idSchema.optional(),
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
        const path = ctx.client.companyPath(ENDPOINTS.jobs);
        const pg = paginationQuery(ctx.config, args.page, args.pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          // Only the fields this tool's formatRow reads — keeps the payload
          // small and avoids fetching HTML-laden columns we never display.
          columns: "ID,JobNumber,Description,Status,Customer,Site,DateIssued",
          ...buildKeywordFilter(args.query, "Description"),
          CustomerID: customerId,
          SiteID: args.siteId,
          Status: args.status,
          DateIssuedFrom: args.dateFrom,
          DateIssuedTo: args.dateTo,
        });
        const items = extractList(resp) as SimproJob[];
        const result = formatList(
          items,
          undefined,
          pg.page,
          pg.pageSize,
          (j) => {
            const status = typeof j.Status === "string" ? j.Status : j.Status?.Name ?? "";
            return `#${j.ID ?? "?"} job ${j.JobNumber ?? ""} — ${stripHtml(j.Description) || "(no description)"}` +
              `${j.Customer?.Name ? ` | customer: ${j.Customer.Name}` : ""}` +
              `${j.Site?.Name ? ` | site: ${j.Site.Name}` : ""}` +
              `${status ? ` | status: ${status}` : ""}` +
              `${j.DateIssued ? ` | issued: ${j.DateIssued}` : ""}`;
          },
          resp,
          args.raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        return result;
      }),
  );

  // ---- 6. get ----
  server.tool(
    "simpro_get_job",
    "Get full details of a Simpro job by ID.",
    { jobId: idSchema, raw: rawFlagSchema },
    async ({ jobId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.jobById(jobId));
        const resp = await ctx.client.get<SimproJob>(path);
        return formatRecord(`Job #${resp.ID ?? jobId} (${resp.JobNumber ?? "no number"})`, resp, resp, raw === true);
      }),
  );

  // ---- 14. create ----
  server.tool(
    "simpro_create_job",
    "Create a new job in Simpro. Requires confirm=true. Note: Simpro typically requires Customer, Site, Type and CostCenter — if your tenant requires fields not exposed here, use rawPayload (look up IDs with simpro_list_job_types, simpro_list_cost_centres, simpro_list_staff).",
    {
      confirm: confirmSchema,
      customerId: idSchema,
      siteId: idSchema,
      description: z.string().min(1),
      jobType: z.union([z.number(), z.string()]).optional().describe("Job Type ID — find with simpro_list_job_types."),
      status: z.union([z.number(), z.string()]).optional().describe("Status ID — find with simpro_list_job_statuses."),
      dueDate: isoDateSchema,
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Customer: { ID: args.customerId },
          Site: { ID: args.siteId },
          Description: args.description,
          Type: args.jobType !== undefined ? { ID: args.jobType } : undefined,
          Status: args.status !== undefined ? { ID: args.status } : undefined,
          DueDate: args.dueDate,
        });
        if (!args.rawPayload && (args.jobType === undefined || args.status === undefined)) {
          // Soft warning baked into the preview — not an error, since some tenants accept defaults.
        }
        const path = ctx.client.companyPath(ENDPOINTS.jobs);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create job for customer #${args.customerId} at site #${args.siteId}`,
        });
        if (blocked) return blocked;
        try {
          const resp = await ctx.client.post<SimproJob>(path, payload);
          return formatRecord(`Created job #${resp.ID ?? "?"} (${resp.JobNumber ?? ""}).`, resp, resp, true);
        } catch (err) {
          // Provide extra hint for common missing-field 400s
          if (err instanceof Error && /required|missing/i.test(err.message)) {
            return textResponse(
              `${err.message}\n\nHint: jobs commonly require Type, CostCenter, Sections, and a Status. ` +
              "Use simpro_list_job_types and simpro_list_cost_centres to find IDs, then retry with rawPayload.",
              true,
            );
          }
          throw err;
        }
      }),
  );

  // ---- 20. update ----
  server.tool(
    "simpro_update_job",
    "Update a Simpro job. Only provided fields are sent. Requires confirm=true.",
    {
      confirm: confirmSchema,
      jobId: idSchema,
      description: z.string().optional(),
      status: z.union([z.number(), z.string()]).optional(),
      dueDate: isoDateSchema,
      assignedStaffIds: z.array(z.union([z.number(), z.string()])).optional(),
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Description: args.description,
          Status: args.status !== undefined ? { ID: args.status } : undefined,
          DueDate: args.dueDate,
          AssignedStaff: args.assignedStaffIds?.map((id) => ({ ID: id })),
        });
        if (Object.keys(payload).length === 0) return textResponse("No fields to update.", true);
        const path = ctx.client.companyPath(ENDPOINTS.jobById(args.jobId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update job #${args.jobId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<SimproJob>(path, payload);
        return formatRecord(`Updated job #${args.jobId}.`, resp, resp, true);
      }),
  );

  // ---- 23. list job statuses (sampled) ----
  // This Simpro tenant doesn't expose a /setup/.../statuses endpoint.
  // We sample recent jobs (which always include {ID, Name, Color} for Status)
  // and de-duplicate. Adjust sampleSize for completeness vs speed.
  server.tool(
    "simpro_list_job_statuses",
    "List job statuses observed across recent jobs (de-duplicated). Useful when updating a job's Status. Note: derived by sampling — recently-unused statuses may not appear.",
    {
      sampleSize: z.number().int().min(1).max(500).optional().describe("How many recent jobs to scan (default 200)."),
    },
    async ({ sampleSize }) =>
      safeRun(async () => {
        const size = sampleSize ?? 200;
        const path = ctx.client.companyPath(ENDPOINTS.jobs);
        const resp = await ctx.client.get<unknown>(path, {
          page: 1, pageSize: size, columns: "ID,Status",
        });
        const items = extractList(resp) as { Status?: { ID?: number; Name?: string; Color?: string } }[];
        const map = new Map<number, { ID: number; Name?: string; Color?: string }>();
        for (const j of items) {
          const s = j.Status;
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

  // ---- 27. list job types (sampled) ----
  // In Simpro Premium, Type is typically a fixed string ("Service" or "Project").
  // We sample to confirm the values present in this tenant.
  server.tool(
    "simpro_list_job_types",
    "List job types observed across recent jobs (de-duplicated). In Simpro Premium this is typically the strings 'Service' and 'Project'.",
    {
      sampleSize: z.number().int().min(1).max(500).optional().describe("How many recent jobs to scan (default 200)."),
    },
    async ({ sampleSize }) =>
      safeRun(async () => {
        const size = sampleSize ?? 200;
        const path = ctx.client.companyPath(ENDPOINTS.jobs);
        const resp = await ctx.client.get<unknown>(path, {
          page: 1, pageSize: size, columns: "ID,Type",
        });
        const items = extractList(resp) as { Type?: unknown }[];
        const seen = new Set<string>();
        for (const j of items) {
          if (j.Type !== undefined && j.Type !== null) seen.add(String(j.Type));
        }
        const list = Array.from(seen).sort();
        return formatList(list, undefined, 1, list.length,
          (t) => t,
          { sampledFrom: items.length, types: list },
          true);
      }),
  );
}
