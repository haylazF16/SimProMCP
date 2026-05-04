import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { idSchema, rawFlagSchema, rawPayloadSchema, confirmSchema, isoDateSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { extractList, formatList, formatRecord, safeRun, textResponse, ToolCtx, writeGuard } from "./_shared.js";

export function registerTaskTools(server: McpServer, ctx: ToolCtx) {
  // ---- 16. create task ----
  server.tool(
    "simpro_create_task",
    "Create a new task in Simpro. Requires confirm=true.",
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
    },
    async (args) =>
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
  server.tool(
    "simpro_update_task",
    "Update a Simpro task. Only provided fields are sent. Requires confirm=true.",
    {
      confirm: confirmSchema,
      taskId: idSchema,
      title: z.string().optional(),
      description: z.string().optional(),
      dueDate: isoDateSchema,
      status: z.string().optional(),
      assignedToId: idSchema.optional(),
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
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
  server.tool(
    "simpro_list_staff",
    "List staff members in Simpro. Useful for assigning tasks/jobs.",
    { raw: rawFlagSchema },
    async ({ raw }) =>
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
  server.tool(
    "simpro_list_cost_centres",
    "List cost centres in Simpro. Useful for creating jobs/quotes that require a CostCenter ID.",
    { raw: rawFlagSchema },
    async ({ raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.costCentres);
        const resp = await ctx.client.get<unknown>(path);
        const items = extractList(resp) as { ID?: number; Name?: string }[];
        return formatList(items, undefined, 1, items.length,
          (c) => `#${c.ID ?? "?"} ${c.Name ?? "(unnamed)"}`, resp, raw === true);
      }),
  );
}
