import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ENDPOINTS,
  ATTACHMENT_ENTITY_TYPES,
  ATTACHMENT_ENTITY_PATHS,
  attachmentFiles,
} from "../simpro/endpoints.js";
import { idSchema, confirmSchema } from "../utils/schemas.js";
import {
  pickSource,
  deriveFilename,
  resolveFileToBase64,
  clearStaging,
} from "../utils/files.js";
import {
  ToolCtx,
  registerTool,
  safeRun,
  textResponse,
  extractList,
  writeGuard,
  jsonBlock,
} from "./_shared.js";

const entityTypeSchema = z
  .enum(ATTACHMENT_ENTITY_TYPES)
  .describe(
    "Which Simpro entity holds the files. 'invoice' auto-resolves to the invoice's linked Job " +
    "(invoices cannot hold attachments directly).",
  );

/**
 * Map an entityType+id to the company-scoped parent suffix for attachments.
 * `invoice` is resolved to its linked Job via a record GET (throws if none).
 */
async function resolveParentSuffix(
  ctx: ToolCtx,
  entityType: string,
  entityId: string | number,
): Promise<string> {
  if (entityType === "invoice") {
    const inv = await ctx.client.get<{ Jobs?: { ID?: number } }>(
      ctx.client.companyPath(ENDPOINTS.invoiceById(entityId)),
    );
    const jobId = inv?.Jobs?.ID;
    if (!jobId) {
      throw new Error(
        `Invoice #${entityId} has no linked Job, so it has nowhere to store attachments. ` +
        `Attach to a Job or purchase order directly.`,
      );
    }
    return ATTACHMENT_ENTITY_PATHS.job(jobId);
  }
  const builder = ATTACHMENT_ENTITY_PATHS[entityType];
  if (!builder) {
    throw new Error(`Unknown entityType "${entityType}". Valid: ${ATTACHMENT_ENTITY_TYPES.join(", ")}.`);
  }
  return builder(entityId);
}

export function registerAttachmentTools(server: McpServer, ctx: ToolCtx) {
  // ---- list attachments (read) ----
  registerTool(
    server,
    "simpro_list_attachments",
    "List files attached to a Simpro entity (job, quote, site, supplier, customer, employee, " +
      "recurringJob, purchaseOrder, or invoice → its linked Job). Read-only.",
    () => ({
      entityType: entityTypeSchema,
      entityId: idSchema,
    }),
    () => async (args) =>
      safeRun(async () => {
        const parent = await resolveParentSuffix(ctx, args.entityType, args.entityId);
        const listPath = ctx.client.companyPath(attachmentFiles(parent));
        const resp = await ctx.client.get<unknown>(listPath);
        const items = extractList(resp) as Array<Record<string, unknown>>;
        const lines = items.length
          ? items
              .map((f) => {
                const kb = typeof f.FileSizeBytes === "number" ? ` ${Math.round(f.FileSizeBytes / 1024)} KB` : "";
                const mt = f.MimeType ? ` [${f.MimeType}]` : "";
                return `- #${f.ID} ${f.Filename ?? "(unnamed)"}${mt}${kb}`;
              })
              .join("\n")
          : "(no attachments)";
        return textResponse(`Attachments on ${args.entityType} #${args.entityId}:\n${lines}`);
      }),
  );

  // ---- upload attachment(s) (write) ----
  registerTool(
    server,
    "simpro_upload_attachment",
    "Upload one or more files into a Simpro entity (job/quote/site/supplier/customer/employee/" +
      "recurringJob/purchaseOrder, or invoice → its Job). Each file gives exactly one of sourceUrl " +
      "(server downloads it), filePath (server reads local disk), or stagingRef (a file dropped on " +
      "the internal portal). Requires confirm=true.",
    () => ({
      confirm: confirmSchema,
      entityType: entityTypeSchema,
      entityId: idSchema,
      files: z
        .array(
          z.object({
            sourceUrl: z.string().url().optional().describe("Direct-download URL the server fetches."),
            filePath: z.string().optional().describe("Path the server reads from local disk."),
            stagingRef: z.string().optional().describe("Ref of a file staged via the portal."),
            filename: z.string().optional().describe("Override the stored filename."),
          }),
        )
        .min(1)
        .describe("One entry per file; each needs exactly one source."),
      public: z.boolean().optional().describe("Visible to the customer in Simpro? Default false (internal)."),
      folderId: idSchema.optional().describe("Optional Simpro attachment folder ID to file it under."),
    }),
    () => async (args) =>
      safeRun(async () => {
        const parent = await resolveParentSuffix(ctx, args.entityType, args.entityId);
        const uploadPath = ctx.client.companyPath(attachmentFiles(parent));

        // Validate sources up front so the confirm/dry-run preview is accurate.
        const preview = args.files.map((f: Record<string, string>) => {
          const which = pickSource(f);
          return { source: which, value: f[which], filename: deriveFilename(f) };
        });
        const blocked = writeGuard(ctx, {
          confirm: args.confirm,
          method: "POST",
          path: uploadPath,
          payload: preview,
          summary: `Upload ${args.files.length} file(s) to ${args.entityType} #${args.entityId}`,
        });
        if (blocked) return blocked;

        const maxBytes = ctx.config.SIMPRO_MAX_ATTACHMENT_MB * 1_048_576;
        const results: Array<Record<string, unknown>> = [];
        for (const f of args.files) {
          try {
            const resolved = await resolveFileToBase64(f, {
              maxBytes,
              stagingDir: ctx.config.SIMPRO_STAGING_DIR,
            });
            const body: Record<string, unknown> = {
              Filename: resolved.filename,
              Base64Data: resolved.base64,
              Public: args.public ?? false,
            };
            if (args.folderId !== undefined) body.Folder = args.folderId;
            const resp = await ctx.client.post<{ ID?: number }>(uploadPath, body);
            results.push({ filename: resolved.filename, status: "created", fileId: resp?.ID });
            if (f.stagingRef) {
              await clearStaging(ctx.config.SIMPRO_STAGING_DIR, f.stagingRef).catch(() => {});
            }
          } catch (err) {
            results.push({
              filename: deriveFilename(f),
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const ok = results.filter((r) => r.status === "created").length;
        const failed = results.length - ok;
        return textResponse(
          `${ok} uploaded, ${failed} failed.\n` + jsonBlock("Results", results),
          ok === 0,
        );
      }),
  );
}
