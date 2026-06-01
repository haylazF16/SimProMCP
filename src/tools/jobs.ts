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
          // NOTE: do not pass a `columns=` selector here. Simpro's /jobs/
          // list endpoint rejects `JobNumber` as a selectable column with
          // "Invalid columns: JobNumber" (observed 2026-05-29 on the
          // Goldman Plumbing tenant), and we need JobNumber in the row
          // output. Fall back to Simpro's default column set.
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
        // Must match applyClientFilters' semantics exactly — otherwise the
        // truncation warning below can fire when no row was actually
        // filtered (e.g. caller passes status: "" → anyFilter true here but
        // applyClientFilters treats empty-string as "no filter").
        const anyFilter =
          customerId != null || args.siteId != null ||
          (args.status !== undefined && args.status !== "") ||
          !!args.dateFrom || !!args.dateTo;
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

  // ---- list_job_sections ----
  // Simpro's GET /jobs/{id} response does NOT include a Sections array —
  // sections are a separate sub-resource. This tool exposes them so Claude
  // can find sectionIds without the user having to fish them out of the
  // Simpro web UI's URL. Each entry includes the section's CostCenters list
  // (with their line-item IDs + setup-level CostCentre IDs) so the caller
  // can tell at a glance whether a section is empty.
  registerTool(
    server,
    "simpro_list_job_sections",
    "List all sections on a Simpro job, with each section's CostCenters (line items). Use this to find sectionIds for simpro_add_section_cost_centre, or to confirm whether a section already has a cost-centre attached.",
    () => (
    {
      jobId: idSchema,
      raw: rawFlagSchema,
    }
    ),
    () => async ({ jobId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.jobSections(jobId));
        const resp = await ctx.client.get<Array<Record<string, unknown>>>(path);
        const sections = Array.isArray(resp) ? resp : [];
        if (sections.length === 0) {
          return textResponse(`Job #${jobId} has no sections.`, false);
        }
        return formatList(
          sections,
          sections.length,
          1,
          sections.length,
          (s) => {
            const id = (s as { ID?: number | string }).ID ?? "?";
            const name = (s as { Name?: string }).Name ?? "(unnamed)";
            const ccList = (s as { CostCenters?: Array<Record<string, unknown>> }).CostCenters ?? [];
            const ccSummary = ccList.length === 0
              ? "empty (no cost centre)"
              : ccList.map((cc) => {
                  const ccId = (cc as { ID?: number | string }).ID ?? "?";
                  const setup = (cc as { CostCentre?: { ID?: number | string; Name?: string } }).CostCentre;
                  return `line #${ccId}${setup ? ` → CostCentre #${setup.ID ?? "?"}${setup.Name ? ` (${setup.Name})` : ""}` : ""}`;
                }).join(", ");
            return `Section #${id} — ${name} — ${ccSummary}`;
          },
          resp,
          raw === true,
        );
      }),
  );

  // ---- add_job_section ----
  // Sections in Simpro are a sub-resource of a job — they can't be created
  // in the same payload as the job itself (the v1.0 API rejects them on
  // POST /jobs and PATCH /jobs/{id}). Each section must be POSTed separately
  // to /jobs/{id}/sections/, and cost-centre line items (which represent the
  // section's billable work bucket) must then be POSTed to a SECOND
  // sub-resource: /jobs/{id}/sections/{sid}/costCenters/. Simpro silently
  // ignores a CostCenter field on the initial section create payload —
  // that's why this tool does both calls.
  registerTool(
    server,
    "simpro_add_job_section",
    "Add a section to an existing Simpro job, optionally with a cost-centre line item attached. Required because sections can't be added during simpro_create_job (Simpro rejects them). Pass costCenterId to also attach a cost-centre line item — this tool will then make TWO API calls (one to create the section, one to attach the cost-centre). If you only want the empty section, omit costCenterId. To attach a cost centre to an existing empty section instead, use simpro_add_section_cost_centre. Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      jobId: idSchema,
      name: z.string().min(1).describe("Section name shown on the job (e.g. 'Commercial Maintenance')."),
      costCenterId: z.union([z.number(), z.string()]).optional()
        .describe("Optional CostCenter ID — find via simpro_list_cost_centres. When supplied, a cost-centre line item is added to the new section in a follow-up API call."),
      rawPayload: rawPayloadSchema.describe("Raw payload override for the section CREATE call only. Does NOT affect the follow-up cost-centre attachment."),
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        // Step 1 — create the section.
        const sectionPayload = args.rawPayload ?? pruneEmpty({ Name: args.name });
        const sectionPath = ctx.client.companyPath(ENDPOINTS.jobSections(args.jobId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path: sectionPath, payload: sectionPayload,
          summary: args.costCenterId !== undefined
            ? `Add section "${args.name}" to job #${args.jobId} + attach CostCenter #${args.costCenterId} (2 API calls)`
            : `Add empty section "${args.name}" to job #${args.jobId}`,
        });
        if (blocked) return blocked;
        const sectionResp = await ctx.client.post<Record<string, unknown>>(sectionPath, sectionPayload);
        const sectionId = (sectionResp as { ID?: number | string }).ID;
        if (sectionId === undefined) {
          return textResponse(
            `Section created on job #${args.jobId} but Simpro didn't return its ID — can't attach cost centre. ` +
            `Inspect the job and use simpro_add_section_cost_centre manually.`,
            true,
          );
        }
        // Step 2 — attach cost centre (only if requested).
        if (args.costCenterId === undefined) {
          return formatRecord(`Added empty section #${sectionId} to job #${args.jobId}.`, sectionResp, sectionResp, true);
        }
        const ccPath = ctx.client.companyPath(ENDPOINTS.jobSectionCostCenters(args.jobId, sectionId));
        const ccPayload = { CostCentre: { ID: args.costCenterId } };
        try {
          const ccResp = await ctx.client.post<Record<string, unknown>>(ccPath, ccPayload);
          const ccLineId = (ccResp as { ID?: number | string }).ID ?? "?";
          return formatRecord(
            `Added section #${sectionId} to job #${args.jobId} with CostCentre #${args.costCenterId} (line #${ccLineId}).`,
            ccResp, { section: sectionResp, costCentre: ccResp }, true,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResponse(
            `Section #${sectionId} created on job #${args.jobId}, but attaching CostCentre #${args.costCenterId} failed: ${msg}\n\n` +
            `You can retry just the attachment via simpro_add_section_cost_centre with jobId=${args.jobId} sectionId=${sectionId} costCentreId=${args.costCenterId}.`,
            true,
          );
        }
      }),
  );

  // ---- add_section_cost_centre ----
  // Standalone: attach a cost-centre line item to an existing job section.
  // Use when a section already exists without a cost centre (e.g. created
  // via the older 1-step version of simpro_add_job_section, or via Simpro UI).
  registerTool(
    server,
    "simpro_add_section_cost_centre",
    "Attach a cost-centre line item to an existing job section. Use when the section exists but is empty (no cost centre = no billable work bucket = can't raise PO against it). Get sectionId from simpro_get_job (look in the Sections array). Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      jobId: idSchema,
      sectionId: idSchema,
      costCentreId: z.union([z.number(), z.string()])
        .describe("CostCentre ID — find via simpro_list_cost_centres."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? { CostCentre: { ID: args.costCentreId } };
        const path = ctx.client.companyPath(ENDPOINTS.jobSectionCostCenters(args.jobId, args.sectionId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Attach CostCentre #${args.costCentreId} to section #${args.sectionId} of job #${args.jobId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<Record<string, unknown>>(path, payload);
        const lineId = (resp as { ID?: number | string }).ID ?? "?";
        return formatRecord(
          `Attached CostCentre #${args.costCentreId} to section #${args.sectionId} of job #${args.jobId} (line #${lineId}).`,
          resp, resp, true,
        );
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

  // ---- update_job_section ----
  // Sections live as a sub-resource of jobs; this tool renames or otherwise
  // updates an existing section after creation. Cost-centre line items on a
  // section are managed via simpro_add_section_cost_centre / future delete
  // tool — NOT through this PATCH (which only mutates the section's own
  // fields like Name and Description).
  registerTool(
    server,
    "simpro_update_job_section",
    "Update an existing section on a Simpro job (e.g. rename it). Only provided fields are sent. Requires confirm=true. Use simpro_list_job_sections to find the sectionId. For cost-centre line items use simpro_add_section_cost_centre.",
    () => (
    {
      confirm: confirmSchema,
      jobId: idSchema,
      sectionId: idSchema,
      name: z.string().optional().describe("New section name."),
      description: z.string().optional().describe("New section description / notes."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Name: args.name,
          Description: args.description,
        });
        if (Object.keys(payload).length === 0) return textResponse("No fields to update.", true);
        const path = ctx.client.companyPath(ENDPOINTS.jobSectionById(args.jobId, args.sectionId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update section #${args.sectionId} of job #${args.jobId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<Record<string, unknown>>(path, payload);
        return formatRecord(`Updated section #${args.sectionId} of job #${args.jobId}.`, resp, resp, true);
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
        // No columns= selector: Simpro's /jobs/ list endpoint rejects some
        // bare column names (see fa7959d — "Invalid columns: JobNumber").
        // The default response includes Status, which is all we need here.
        const resp = await ctx.client.get<unknown>(path, {
          page: 1, pageSize: size,
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
        // No columns= selector: see simpro_list_job_statuses comment above.
        // Type is included in Simpro's default /jobs/ list response.
        const resp = await ctx.client.get<unknown>(path, {
          page: 1, pageSize: size,
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
