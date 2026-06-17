import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS, rootPath } from "../simpro/endpoints.js";
import { idSchema, rawPayloadSchema, confirmSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { formatRecord, safeRun, textResponse, ToolCtx, writeGuard, jsonBlock, registerTool } from "./_shared.js";

export function registerNoteTools(server: McpServer, ctx: ToolCtx) {
  // ---- 17. add job note ----
  registerTool(
    server,
    "simpro_add_job_note",
    "Add a note to a Simpro job. Requires confirm=true.",
    () => (
    {
      confirm: confirmSchema,
      jobId: idSchema,
      note: z.string().min(1),
      visibility: z.string().optional().describe("Optional visibility flag (e.g. 'internal', 'customer'). Tenants vary — leave blank if unsure."),
      rawPayload: rawPayloadSchema,
    }
    ),
    () => async (args) =>
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

  // ---- attach a file LINK as a job note (deliberate choice, not a workaround) ----
  // Simpro's v1.0 REST API DOES support native binary attachments — see
  // src/tools/attachments.ts (simpro_upload_attachment). This tool is the
  // alternative for cases where you'd rather keep the file in its existing
  // store (SharePoint/OneDrive/Dropbox) and just record a clickable pointer in
  // the job timeline — e.g. very large files, or links that should stay live.
  registerTool(
    server,
    "simpro_attach_file_link_to_job",
    "Post a link to an externally-stored file (SharePoint, OneDrive, Dropbox, etc.) as a structured job note. The file stays where it is; the job timeline shows a clearly labelled clickable note. Requires confirm=true. NOTE: for a TRUE Simpro attachment (bytes stored in Simpro), use simpro_upload_attachment instead — this link tool is for when you'd rather keep the file external (e.g. very large files).",
    () => (
    {
      confirm: confirmSchema,
      jobId: idSchema,
      fileUrl: z.string().url()
        .describe("Public or shared link to the file. SharePoint/OneDrive 'Anyone with link' URLs work best."),
      description: z.string().min(1)
        .describe("What the file is, e.g. 'Site photo - basement leak' or 'Quote PDF from Reece'."),
      visibility: z.string().optional()
        .describe("Optional visibility flag for the note. Leave blank if unsure."),
    }
    ),
    () => async (args) =>
      safeRun(async () => {
        const noteText =
          `ATTACHMENT (link): ${args.description}\n` +
          `Link: ${args.fileUrl}\n` +
          `(Linked via Goldman Simpro AI tool — file stored externally. For a native ` +
          `Simpro attachment, simpro_upload_attachment uploads the bytes directly.)`;
        const payload = pruneEmpty({
          Note: noteText,
          Visibility: args.visibility,
        });
        const path = ctx.client.companyPath(ENDPOINTS.jobNotes(args.jobId));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm, method: "POST", path, payload,
          summary: `Attach file link "${args.description}" to job #${args.jobId}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<{ ID?: number }>(path, payload);
        return formatRecord(
          `Attached file link to job #${args.jobId}: ${args.description}\n` +
          `URL: ${args.fileUrl}\n` +
          `(Saved as job note id #${resp.ID ?? "?"}.)`,
          resp, resp, true,
        );
      }),
  );

  // ---- 11. company info / connection test ----
  registerTool(
    server,
    "simpro_get_company_info",
    "Test the Simpro connection and return the configured company ID plus any account info the API exposes.",
    () => (
    {}
    ),
    () => async () =>
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
