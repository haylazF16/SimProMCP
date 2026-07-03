import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { idSchema, rawFlagSchema, rawPayloadSchema, confirmSchema, isoDateSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, writeGuard, registerTool } from "./_shared.js";

export function registerTaskTools(server: McpServer, ctx: ToolCtx) {
  // ---- 16. create task ----
  registerTool(
    server,
    "simpro_create_task",
    "Create a new task in Simpro. Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      title: z.string().min(1),
      description: z.string().optional(),
      dueDate: isoDateSchema,
      assignedToId: idSchema.optional(),
      customerId: idSchema.optional(),
      siteId: idSchema.optional(),
      jobId: idSchema.optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Subject: args.title,
          Notes: args.description,
          DueDate: args.dueDate,
          Staff: args.assignedToId !== undefined ? { ID: args.assignedToId } : undefined,
          Customer: args.customerId !== undefined ? { ID: args.customerId } : undefined,
          Site: args.siteId !== undefined ? { ID: args.siteId } : undefined,
          Job: args.jobId !== undefined ? { ID: args.jobId } : undefined,
        });
        const path = ctx.client.companyPath(ENDPOINTS.tasks);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Create task "${args.title}"`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<{ ID?: number }>(path, payload);
        return formatRecord(`Created task #${resp.ID ?? "?"}.`, resp, resp, true);
      }),
  );

  // ---- 22. update task ----
  registerTool(
    server,
    "simpro_update_task",
    "Update a Simpro task. Only provided fields are sent. Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      taskId: idSchema,
      title: z.string().optional(),
      description: z.string().optional(),
      dueDate: isoDateSchema,
      status: z.string().optional(),
      assignedToId: idSchema.optional(),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Subject: args.title,
          Notes: args.description,
          DueDate: args.dueDate,
          Status: args.status,
          Staff: args.assignedToId !== undefined ? { ID: args.assignedToId } : undefined,
        });
        if (Object.keys(payload).length === 0) return textResponse("No fields to update.", true);
        const path = ctx.client.companyPath(ENDPOINTS.taskById(args.taskId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "PATCH", path, payload,
          summary: `Update task #${args.taskId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.patch<unknown>(path, payload);
        return formatRecord(`Updated task #${args.taskId}.`, resp, resp, true);
      }),
  );

  // ---- 25. list staff ----
  registerTool(
    server,
    "simpro_list_staff",
    "List staff members in Simpro. Useful for assigning tasks/jobs.",
    () => (
    { raw: rawFlagSchema }
    ),
    () => async ({ raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.staff);
        const resp = await ctx.client.get<unknown>(path);
        const items = extractList(resp) as { ID?: number; GivenName?: string; FamilyName?: string; Email?: string }[];
        return formatList(items, undefined, 1, items.length,
          (s) => `#${s.ID ?? "?"} ${[s.GivenName, s.FamilyName].filter(Boolean).join(" ") || "(unnamed)"}` +
            `${s.Email ? ` <${s.Email}>` : ""}`,
          resp, raw === true);
      }),
  );

  // ---- 26. list cost centres ----
  registerTool(
    server,
    "simpro_list_cost_centres",
    "List cost centres in Simpro. Useful for creating jobs/quotes that require a CostCenter ID.",
    () => (
    { raw: rawFlagSchema }
    ),
    () => async ({ raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.costCentres);
        const resp = await ctx.client.get<unknown>(path);
        const items = extractList(resp) as { ID?: number; Name?: string }[];
        return formatList(items, undefined, 1, items.length,
          (c) => `#${c.ID ?? "?"} ${c.Name ?? "(unnamed)"}`, resp, raw === true);
      }),
  );

  // ---- get task ----
  registerTool(
    server,
    "simpro_get_task",
    "Get one Simpro task by ID (subject, assignee, due date, status). Use simpro_list_tasks to find IDs.",
    () => ({ taskId: idSchema, raw: rawFlagSchema }),
    () => async ({ taskId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.taskById(taskId));
        const resp = await ctx.client.get<{ ID?: number; Subject?: string }>(path);
        return formatRecord(`Task #${resp.ID ?? taskId}: ${resp.Subject ?? "(no subject)"}`, resp, resp, raw === true);
      }),
  );

  // ---- list tasks ----
  registerTool(
    server,
    "simpro_list_tasks",
    "List Simpro tasks (paginated). Use simpro_get_task for one task's full detail.",
    () => ({ page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(1000).optional(), raw: rawFlagSchema }),
    () => async ({ page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.tasks);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, { ...pg.query });
        const items = extractList(resp) as { ID?: number; Subject?: string }[];
        return formatList(items, undefined, pg.page, pg.pageSize,
          (t) => `#${t.ID ?? "?"} ${t.Subject ?? "(no subject)"}`, resp, raw === true);
      }),
  );

  // ---- get staff member ----
  registerTool(
    server,
    "simpro_get_staff_member",
    "Get one Simpro staff member by ID (name, type). Use simpro_list_staff to find IDs.",
    () => ({ staffId: idSchema, raw: rawFlagSchema }),
    () => async ({ staffId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.staffById(staffId));
        // Employees carry GivenName/FamilyName; contractor staff rows carry a
        // flat Name (verified live against company 4, 2026-07-03).
        const resp = await ctx.client.get<{ ID?: number; GivenName?: string; FamilyName?: string; Name?: string }>(path);
        const name = [resp.GivenName, resp.FamilyName].filter(Boolean).join(" ") || resp.Name || "(unnamed)";
        return formatRecord(`Staff #${resp.ID ?? staffId}: ${name}`, resp, resp, raw === true);
      }),
  );

  // ---- get cost centre ----
  registerTool(
    server,
    "simpro_get_cost_centre",
    "Get one Simpro cost centre (setup) by ID. Use simpro_list_cost_centres to find IDs.",
    () => ({ costCentreId: idSchema, raw: rawFlagSchema }),
    () => async ({ costCentreId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.costCentreById(costCentreId));
        const resp = await ctx.client.get<{ ID?: number; Name?: string }>(path);
        return formatRecord(`Cost centre #${resp.ID ?? costCentreId}: ${resp.Name ?? "(unnamed)"}`, resp, resp, raw === true);
      }),
  );
}
