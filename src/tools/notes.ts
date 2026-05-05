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

  // ---- attach file link (workaround for missing attachment API) ----
  // Simpro v1.0 REST API does NOT expose attachments/files/documents (verified
  // by exhaustive endpoint sweep). The closest workaround is to upload the
  // file to a SharePoint/OneDrive folder + post a link to it as a job note.
  // This tool standardises that flow: the note shows up clearly in the
  // Simpro web UI's job timeline as "ATTACHMENT: <description> -> <url>"
  // and a click takes the user to the actual file.
  //
  // For a true attachment (file binary stored inside Simpro) the user would
  // need Simpro's separate "Files API" product — ask Simpro support about it.
  server.tool(
    "simpro_attach_file_link_to_job",
    "Workaround for Simpro's missing attachment API: post a link to a file (stored in SharePoint, OneDrive, Dropbox, etc.) as a structured job note. The file itself stays where it is; the job in Simpro shows a clearly labelled clickable note pointing at it. Requires confirm=true. NOTE: this is NOT a true Simpro attachment — Simpro's REST API doesn't support binary file uploads. For native attachments, use the Simpro web UI directly, or contact Simpro support about their separate Files API product.",
    {
      confirm: confirmSchema,
      jobId: idSchema,
      fileUrl: z.string().url()
        .describe("Public or shared link to the file. SharePoint/OneDrive 'Anyone with link' URLs work best."),
      description: z.string().min(1)
        .describe("What the file is, e.g. 'Site photo - basement leak' or 'Quote PDF from Reece'."),
      visibility: z.string().optional()
        .describe("Optional visibility flag for the note. Leave blank if unsure."),
    },
    async (args) =>
      safeRun(async () => {
        const noteText =
          `ATTACHMENT: ${args.description}\n` +
          `Link: ${args.fileUrl}\n` +
          `(Linked via Goldman Simpro AI tool — file stored externally, Simpro REST API does not support binary attachments.)`;
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
