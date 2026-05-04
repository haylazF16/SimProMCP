import { z } from "zod";

/** Simpro IDs are commonly numeric, but we accept strings for safety. */
export const idSchema = z.union([z.number().int().positive(), z.string().min(1)]);

export const pageSchema = z.number().int().min(1).optional();
export const pageSizeSchema = z.number().int().min(1).max(1000).optional();

export const rawPayloadSchema = z.record(z.any()).optional()
  .describe("Advanced: raw Simpro API payload — bypasses field mapping. Provide the exact JSON Simpro expects.");

export const confirmSchema = z.boolean()
  .describe("Must be true to actually run a write operation. If false, returns a preview/confirmation request.");

export const addressSchema = z.object({
  Address: z.string().optional(),
  City: z.string().optional(),
  State: z.string().optional(),
  PostalCode: z.string().optional(),
  Country: z.string().optional(),
}).partial().optional();

export const rawFlagSchema = z.boolean().optional().describe("If true, include the raw Simpro JSON response.");

export const isoDateSchema = z.string().optional()
  .describe("ISO date string (YYYY-MM-DD) or ISO datetime.");
