import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ENDPOINTS,
  ATTACHMENT_ENTITY_TYPES,
  ATTACHMENT_ENTITY_PATHS,
  attachmentFiles,
  attachmentFileById,
} from "../simpro/endpoints.js";
import { idSchema, confirmSchema } from "../utils/schemas.js";
import {
  pickSource,
  deriveFilename,
  resolveFileToBase64,
  writeBase64ToPath,
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
  type McpTextResponse,
} from "./_shared.js";

const entityTypeSchema = z
  .enum(ATTACHMENT_ENTITY_TYPES)
  .describe(
    "Which Simpro entity holds the files. 'invoice' auto-resolves to the invoice's linked Job " +
    "(invoices cannot hold attachments directly).",
  );

/** MCP content can be text or an inline image; the shared helper type is text-only. */
type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function multiResponse(content: McpContent[], isError = false): McpTextResponse {
  return { content, isError } as unknown as McpTextResponse;
}

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

  // ---- download attachment(s) (read) ----
  registerTool(
    server,
    "simpro_download_attachment",
    "Download one or more attachments by fileId. Images render inline; pass saveDir (or per-file " +
      "savePath) to write bytes to disk; otherwise returns metadata only (use returnBase64=true to " +
      "force bytes into the response). Read-only.",
    () => ({
      entityType: entityTypeSchema,
      entityId: idSchema,
      files: z
        .array(
          z.object({
            fileId: idSchema,
            savePath: z.string().optional().describe("Write THIS file to this exact path."),
          }),
        )
        .min(1),
      saveDir: z.string().optional().describe("Write all downloaded files into this directory."),
      returnBase64: z.boolean().optional().describe("Force base64 bytes into the response, even for non-images."),
    }),
    () => async (args) =>
      safeRun(async () => {
        const parent = await resolveParentSuffix(ctx, args.entityType, args.entityId);
        const maxBytes = ctx.config.SIMPRO_MAX_ATTACHMENT_MB * 1_048_576;
        const content: McpContent[] = [];
        const results: Array<Record<string, unknown>> = [];

        for (const f of args.files) {
          try {
            const filePath = ctx.client.companyPath(attachmentFileById(parent, f.fileId));
            const rec = await ctx.client.get<{ Base64Data?: string; MimeType?: string; Filename?: string }>(
              filePath,
              { display: "Base64" },
            );
            const b64 = rec.Base64Data ?? "";
            const mime = rec.MimeType ?? "application/octet-stream";
            const name = rec.Filename ?? `file-${f.fileId}`;
            const sizeBytes = Math.floor((b64.length * 3) / 4);

            if (f.savePath || args.saveDir) {
              const dest = f.savePath ?? path.join(args.saveDir as string, name);
              const abs = await writeBase64ToPath(b64, dest);
              results.push({ fileId: f.fileId, filename: name, status: "saved", savedTo: abs });
            } else if (mime.startsWith("image/")) {
              if (sizeBytes > maxBytes) {
                results.push({
                  fileId: f.fileId,
                  filename: name,
                  status: "error",
                  error: `Image too large to inline (${(sizeBytes / 1_048_576).toFixed(1)} MB); pass saveDir.`,
                });
              } else {
                content.push({ type: "image", data: b64, mimeType: mime });
                results.push({ fileId: f.fileId, filename: name, status: "inline" });
              }
            } else if (args.returnBase64) {
              if (sizeBytes > maxBytes) {
                results.push({
                  fileId: f.fileId,
                  filename: name,
                  status: "error",
                  error: `Too large to inline (${(sizeBytes / 1_048_576).toFixed(1)} MB); pass saveDir.`,
                });
              } else {
                content.push({ type: "text", text: jsonBlock(`${name} (base64)`, { mimeType: mime, base64: b64 }) });
                results.push({ fileId: f.fileId, filename: name, status: "inline" });
              }
            } else {
              results.push({
                fileId: f.fileId,
                filename: name,
                status: "metadata",
                mimeType: mime,
                note: "Pass saveDir/savePath to download bytes, or returnBase64=true to inline.",
              });
            }
          } catch (err) {
            results.push({
              fileId: f.fileId,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const delivered = results.filter((r) => r.status === "saved" || r.status === "inline").length;
        const failed = results.filter((r) => r.status === "error").length;
        const meta = results.filter((r) => r.status === "metadata").length;
        const summary = `${delivered} delivered, ${meta} metadata-only, ${failed} failed.`;
        content.unshift({ type: "text", text: `${summary}\n${jsonBlock("Files", results)}` });
        return multiResponse(content, delivered === 0 && failed > 0);
      }),
  );

  // ---- delete attachment(s) (write) ----
  registerTool(
    server,
    "simpro_delete_attachment",
    "Delete one or more attachments by fileId from a Simpro entity. Requires confirm=true.",
    () => ({
      confirm: confirmSchema,
      entityType: entityTypeSchema,
      entityId: idSchema,
      fileIds: z.array(idSchema).min(1).describe("IDs of the attachments to delete."),
    }),
    () => async (args) =>
      safeRun(async () => {
        const parent = await resolveParentSuffix(ctx, args.entityType, args.entityId);
        const samplePath = ctx.client.companyPath(attachmentFileById(parent, args.fileIds[0]));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm,
          method: "DELETE",
          path: samplePath,
          payload: { fileIds: args.fileIds },
          summary: `Delete ${args.fileIds.length} attachment(s) from ${args.entityType} #${args.entityId}`,
        });
        if (blocked) return blocked;

        const results: Array<Record<string, unknown>> = [];
        for (const id of args.fileIds) {
          try {
            await ctx.client.del(ctx.client.companyPath(attachmentFileById(parent, id)));
            results.push({ fileId: id, status: "deleted" });
          } catch (err) {
            results.push({ fileId: id, status: "error", error: err instanceof Error ? err.message : String(err) });
          }
        }
        const ok = results.filter((r) => r.status === "deleted").length;
        return textResponse(`${ok} deleted, ${results.length - ok} failed.\n` + jsonBlock("Results", results), ok === 0);
      }),
  );
}
