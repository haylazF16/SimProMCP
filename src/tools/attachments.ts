import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ENDPOINTS,
  ATTACHMENT_ENTITY_TYPES,
  ATTACHMENT_ENTITY_PATHS,
  attachmentFiles,
} from "../simpro/endpoints.js";
import { idSchema } from "../utils/schemas.js";
import {
  ToolCtx,
  registerTool,
  safeRun,
  textResponse,
  extractList,
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
}
