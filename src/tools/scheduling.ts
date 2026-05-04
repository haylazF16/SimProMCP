// Scheduling tools: staff schedules, timesheets, recurring jobs.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { idSchema, rawFlagSchema, isoDateSchema } from "../utils/schemas.js";
import { extractList, formatList, formatRecord, safeRun, ToolCtx } from "./_shared.js";
import { stripHtml } from "../utils/sanitise.js";

interface SimproSchedule {
  ID?: number;
  Type?: string;
  Reference?: string;
  TotalHours?: number;
  Staff?: { ID?: number; Name?: string };
  Date?: string;
  Blocks?: Array<{ Hrs?: number; StartTime?: string; EndTime?: string; ScheduleRate?: { Name?: string } }>;
  [key: string]: unknown;
}

interface SimproTimesheet {
  UID?: string;
  ScheduleType?: string;
  Reference?: string;
  Date?: string;
  StartTime?: string;
  EndTime?: string;
  TotalHrs?: number;
  ScheduleRate?: { ID?: number; Name?: string };
  Cost?: number;
  TotalCost?: number;
  EmployeeID?: number;
  [key: string]: unknown;
}

interface SimproRecurringJob {
  ID?: number;
  Description?: string;
  Customer?: { ID?: number; CompanyName?: string };
  Site?: { ID?: number; Name?: string };
  [key: string]: unknown;
}

export function registerSchedulingTools(server: McpServer, ctx: ToolCtx) {
  // ---- search schedules ----
  server.tool(
    "simpro_search_schedules",
    "Search Simpro staff schedules (work blocks assigned to employees). Filter by staff and/or date range.",
    {
      staffId: idSchema.optional().describe("Filter to one staff member's schedule."),
      dateFrom: isoDateSchema,
      dateTo: isoDateSchema,
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async ({ staffId, dateFrom, dateTo, page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.schedules);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          "Staff.ID": staffId,
          DateFrom: dateFrom,
          DateTo: dateTo,
        });
        const items = extractList(resp) as SimproSchedule[];
        return formatList(
          items, undefined, pg.page, pg.pageSize,
          (s) =>
            `#${s.ID ?? "?"} ${s.Type ?? ""}` +
            `${s.Date ? ` | date: ${s.Date}` : ""}` +
            `${s.Staff?.Name ? ` | staff: ${s.Staff.Name}` : ""}` +
            `${s.TotalHours !== undefined ? ` | hrs: ${s.TotalHours}` : ""}` +
            `${s.Reference ? ` | ref: ${s.Reference}` : ""}`,
          resp, raw === true,
        );
      }),
  );

  // ---- search timesheets ----
  server.tool(
    "simpro_search_timesheets",
    "Search Simpro timesheets (recorded labour hours and cost). Filter by employee and/or date range.",
    {
      employeeId: idSchema.optional().describe("Filter to one employee's timesheet entries."),
      dateFrom: isoDateSchema,
      dateTo: isoDateSchema,
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async ({ employeeId, dateFrom, dateTo, page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.timesheets);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          EmployeeID: employeeId,
          DateFrom: dateFrom,
          DateTo: dateTo,
        });
        const items = extractList(resp) as SimproTimesheet[];
        return formatList(
          items, undefined, pg.page, pg.pageSize,
          (t) =>
            `#${t.UID ?? "?"} ${t.ScheduleType ?? ""}` +
            `${t.Date ? ` | ${t.Date}` : ""}` +
            `${t.StartTime ? ` ${t.StartTime}-${t.EndTime}` : ""}` +
            `${t.TotalHrs !== undefined ? ` | hrs: ${t.TotalHrs}` : ""}` +
            `${t.ScheduleRate?.Name ? ` | rate: ${t.ScheduleRate.Name}` : ""}` +
            `${t.TotalCost !== undefined ? ` | cost: $${t.TotalCost}` : ""}` +
            `${t.EmployeeID !== undefined ? ` | empId: ${t.EmployeeID}` : ""}`,
          resp, raw === true,
        );
      }),
  );

  // ---- search recurring jobs ----
  server.tool(
    "simpro_search_recurring_jobs",
    "Search Simpro recurring job templates (PM contracts etc). Use `customerName` or `customerId` to find a specific customer's recurring jobs.",
    {
      customerName: z.string().optional()
        .describe("Customer name — internally resolved to customerId via simpro_search_customers."),
      customerId: idSchema.optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async (args) =>
      safeRun(async () => {
        const { resolveCustomerByName } = await import("../utils/resolveCustomer.js");
        let customerId = args.customerId;
        let resolvedNote = "";
        if (!customerId && args.customerName) {
          const lookup = await resolveCustomerByName(ctx.client, args.customerName);
          if (!lookup.matchedId) {
            return { content: [{ type: "text" as const, text: lookup.note }], isError: true };
          }
          customerId = lookup.matchedId;
          resolvedNote = lookup.note + "\n\n";
        }
        const path = ctx.client.companyPath(ENDPOINTS.recurringJobs);
        const pg = paginationQuery(ctx.config, args.page, args.pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          "Customer.ID": customerId,
        });
        const items = extractList(resp) as SimproRecurringJob[];
        const result = formatList(
          items, undefined, pg.page, pg.pageSize,
          (j) =>
            `#${j.ID ?? "?"}` +
            `${j.Customer?.CompanyName ? ` | customer: ${j.Customer.CompanyName}` : ""}` +
            `${j.Site?.Name ? ` | site: ${j.Site.Name}` : ""}` +
            `${j.Description ? ` — ${stripHtml(j.Description)}` : ""}`,
          resp, args.raw === true,
        );
        if (resolvedNote) result.content[0].text = resolvedNote + result.content[0].text;
        return result;
      }),
  );

  // ---- get recurring job ----
  server.tool(
    "simpro_get_recurring_job",
    "Get full detail of a Simpro recurring job template by ID.",
    { recurringJobId: idSchema, raw: rawFlagSchema },
    async ({ recurringJobId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.recurringJobById(recurringJobId));
        const resp = await ctx.client.get<SimproRecurringJob>(path);
        return formatRecord(`Recurring Job #${resp.ID ?? recurringJobId}`, resp, resp, raw === true);
      }),
  );
}
