import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { resolveCustomerByName } from "../utils/resolveCustomer.js";
import { applyClientFilters } from "../utils/listFilter.js";
import { stripHtml } from "../utils/sanitise.js";
import { idSchema, rawFlagSchema, rawPayloadSchema, confirmSchema, isoDateSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, writeGuard, registerTool } from "./_shared.js";
import { SimproJob } from "../simpro/types.js";

export function registerJobTools(server: McpServer, ctx: ToolCtx) {
  // ---- 5. search ----
  registerTool(
    server,
    "simpro_search_jobs",
    "Search Simpro jobs. Filters by customer (pass `customerId`, or `customerName` to auto-resolve), `siteId`, `status` (case-insensitive name), and `dateFrom`/`dateTo` (issue date, inclusive, yyyy-mm-dd) — all applied client-side after fetching. The `query` field ONLY matches inside the job's Description (HTML body) — DO NOT put a customer name there.",
    () => (
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
        const path = ctx.client.companyPath(ENDPOINTS.jobs);
        // Simpro list endpoints silently ignore unknown filter params, so
        // CustomerID/SiteID/Status/DateIssued* never worked server-side. We
        // fetch a large page and filter in-process instead.
        // Filtered search needs a wide, NEWEST-first scan window. Simpro v1.0
        // list endpoints default to oldest-first by ID, so without orderby the
        // 100-record default would only ever cover the most ancient records and
        // miss the customer's recent jobs. 250 is the agreed scan cap.
        const fetchSize = 250;
        const resp = await ctx.client.get<unknown>(path, {
          page: 1,
          pageSize: fetchSize,
          orderby: "-ID",
          // Only the fields this tool's formatRow reads — keeps the payload
          // small and avoids fetching HTML-laden columns we never display.
          columns: "ID,JobNumber,Description,Status,Customer,Site,DateIssued",
          ...buildKeywordFilter(args.query, "Description"),
        });
        const fetched = extractList(resp) as SimproJob[];
        const filtered = applyClientFilters(
          fetched,
          { customerId, siteId: args.siteId, status: args.status, dateFrom: args.dateFrom, dateTo: args.dateTo },
          { dateField: "DateIssued" },
        );
        const limit = args.pageSize ?? ctx.config.SIMPRO_DEFAULT_PAGE_SIZE;
        const items = filtered.slice(0, limit);
        const anyFilter =
          customerId !== undefined || args.siteId !== undefined ||
          args.status !== undefined || args.dateFrom !== undefined || args.dateTo !== undefined;
        const result = formatList(
          items,
          undefined,
          1,
          limit,
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
        if (fetched.length === fetchSize && anyFilter) {
          result.content[0].text +=
            `\n\n(Showing matches within the first ${fetchSize} records scanned. If an expected match is missing, narrow your search.)`;
        }
        return result;
      }),
  );

  // ---- 6. get ----
  registerTool(
    server,
    "simpro_get_job",
    "Get full details of a Simpro job by ID.",
    () => (
    { jobId: idSchema, raw: rawFlagSchema }
    ),
    () => async ({ jobId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.jobById(jobId));
        const resp = await ctx.client.get<SimproJob>(path);
        return formatRecord(`Job #${resp.ID ?? jobId} (${resp.JobNumber ?? "no number"})`, resp, resp, raw === true);
      }),
  );

  // ---- 14. create ----
  registerTool(
    server,
    "simpro_create_job",
    "Create a new job in Simpro. Requires confirm=true. Note: Simpro typically requires Customer, Site, Type and CostCenter — if your tenant requires fields not exposed here, use rawPayload (look up IDs with simpro_list_job_types, simpro_list_cost_centres, simpro_list_staff).",
    () => (
    {
      confirm: confirmSchema,
      customerId: idSchema,
      siteId: idSchema,
      description: z.string().min(1),
      jobType: z.union([z.number(), z.string()]).optional().describe("Job Type ID — find with simpro_list_job_types."),
      status: z.union([z.number(), z.string()]).optional().describe("Status ID — find with simpro_list_job_statuses."),
      dueDate: isoDateSchema,
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
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

  // ---- add_job_section ----
  // Sections in Simpro are a sub-resource of a job — they can't be created
  // in the same payload as the job itself (the v1.0 API rejects them on
  // POST /jobs and PATCH /jobs/{id}). Each section must be POSTed separately
  // to /jobs/{id}/sections/. Each section is bound to exactly one CostCenter.
  registerTool(
    server,
    "simpro_add_job_section",
    "Add a section (a cost-centre line) to an existing Simpro job. Required because sections cannot be added during simpro_create_job (the API rejects them). Each section binds to one CostCenter — look up IDs via simpro_list_cost_centres. Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      jobId: idSchema,
      name: z.string().min(1).describe("Section name shown on the job (e.g. 'Commercial Maintenance')."),
      costCenterId: z.union([z.number(), z.string()])
        .describe("CostCenter ID — find via simpro_list_cost_centres."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Name: args.name,
          CostCenter: { ID: args.costCenterId },
        });
        const path = ctx.client.companyPath(ENDPOINTS.jobSections(args.jobId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Add section "${args.name}" to job #${args.jobId} (CostCenter #${args.costCenterId})`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<Record<string, unknown>>(path, payload);
        const sectionId = (resp as { ID?: number | string }).ID ?? "?";
        return formatRecord(`Added section #${sectionId} to job #${args.jobId}.`, resp, resp, true);
      }),
  );

  // ---- 20. update ----
  registerTool(
    server,
    "simpro_update_job",
    "Update a Simpro job. Only provided fields are sent. Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      jobId: idSchema,
      description: z.string().optional(),
      status: z.union([z.number(), z.string()]).optional(),
      dueDate: isoDateSchema,
      assignedStaffIds: z.array(z.union([z.number(), z.string()])).optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Description: args.description,
          Status: args.status !== undefined ? { ID: args.status } : undefined,
          DueDate: args.dueDate,
          AssignedStaff: args.assignedStaffIds?.map((id: number | string) => ({ ID: id })),
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
  registerTool(
    server,
    "simpro_list_job_statuses",
    "List job statuses observed across recent jobs (de-duplicated). Useful when updating a job's Status. Note: derived by sampling — recently-unused statuses may not appear.",
    () => (
    {
      sampleSize: z.number().int().min(1).max(500).optional().describe("How many recent jobs to scan (default 200)."),
    }
    ),
    () => async ({ sampleSize }) =>
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
  registerTool(
    server,
    "simpro_list_job_types",
    "List job types observed across recent jobs (de-duplicated). In Simpro Premium this is typically the strings 'Service' and 'Project'.",
    () => (
    {
      sampleSize: z.number().int().min(1).max(500).optional().describe("How many recent jobs to scan (default 200)."),
    }
    ),
    () => async ({ sampleSize }) =>
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
