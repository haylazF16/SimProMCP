import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS, rootPath } from "../simpro/endpoints.js";
import { idSchema, rawPayloadSchema, confirmSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { formatRecord, safeRun, textResponse, ToolCtx, writeGuard, jsonBlock } from "./_shared.js";

export function registerNoteTools(server: McpServer, ctx: ToolCtx) {
  // ---- 17. add job note ----
  server.tool(
    "simpro_add_job_note",
    "Add a note to a Simpro job. Requires confirm=true.",
    {
      confirm: confirmSchema,
      jobId: idSchema,
      note: z.string().min(1),
      visibility: z.string().optional().describe("Optional visibility flag (e.g. 'internal', 'customer'). Tenants vary — leave blank if unsure."),
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Note: args.note,
          Visibility: args.visibility,
        });
        const path = ctx.client.companyPath(ENDPOINTS.jobNotes(args.jobId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Add note to job #${args.jobId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<{ ID?: number }>(path, payload);
        return formatRecord(`Added note (id #${resp.ID ?? "?"}) to job #${args.jobId}.`, resp, resp, true);
      }),
  );

  // ---- 11. company info / connection test ----
  server.tool(
    "simpro_get_company_info",
    "Test the Simpro connection and return the configured company ID plus any account info the API exposes.",
    {},
    async () =>
      safeRun(async () => {
        const path = rootPath(ENDPOINTS.info);
        let info: unknown = null;
        let infoError: string | null = null;
        try {
          info = await ctx.client.get<unknown>(path);
        } catch (err) {
          infoError = err instanceof Error ? err.message : String(err);
        }
        // Verify the configured company ID + auth by hitting a cheap, known-
        // valid resource under it. (A bare /companies/{id}/ directory listing
        // is NOT a Simpro endpoint and returns 404.)
        const companyProbe = ctx.client.companyPath("/jobs/?pageSize=1");
        let companyOk = false;
        let companyError: string | null = null;
        try {
          await ctx.client.get<unknown>(companyProbe);
          companyOk = true;
        } catch (err) {
          companyError = err instanceof Error ? err.message : String(err);
        }

        const status = companyOk
          ? "Simpro connection OK."
          : "Simpro connection FAILED — see details below.";

        const lines = [
          status,
          `Base URL: ${ctx.config.SIMPRO_BASE_URL}`,
          `Company ID: ${ctx.config.SIMPRO_COMPANY_ID}`,
          `Write tools enabled: ${ctx.config.SIMPRO_ENABLE_WRITE_TOOLS}`,
          `Dry run: ${ctx.config.SIMPRO_DRY_RUN}`,
        ];
        if (infoError) lines.push(`Info endpoint error: ${infoError}`);
        if (companyError) lines.push(`Company endpoint error: ${companyError}`);
        if (info) lines.push("", jsonBlock("Account info", info));

        return textResponse(lines.join("\n"), !companyOk);
      }),
  );
}
