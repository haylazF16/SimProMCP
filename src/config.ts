import "dotenv/config";
import { z } from "zod";

const boolFromString = z
  .union([z.string(), z.boolean()])
  .transform((v) => (typeof v === "boolean" ? v : v.toLowerCase() === "true"));

const intFromString = (def: number, min = 1, max = 600_000) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const ConfigSchema = z.object({
  SIMPRO_BASE_URL: z
    .string()
    .url("SIMPRO_BASE_URL must be a full URL like https://yourcompany.simprosuite.com")
    .transform((u) => u.replace(/\/+$/, "")),
  SIMPRO_API_KEY: z.string().min(8, "SIMPRO_API_KEY is missing or too short"),
  SIMPRO_COMPANY_ID: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => v.length > 0, "SIMPRO_COMPANY_ID is required"),
  SIMPRO_ENABLE_WRITE_TOOLS: boolFromString.default(false),
  SIMPRO_DRY_RUN: boolFromString.default(true),
  SIMPRO_REQUEST_TIMEOUT_MS: intFromString(30_000, 1_000, 600_000),
  SIMPRO_MAX_PAGE_SIZE: intFromString(100, 1, 1000),
  SIMPRO_DEFAULT_PAGE_SIZE: intFromString(25, 1, 1000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    const msg =
      "Simpro MCP server cannot start — environment configuration is invalid:\n" +
      issues +
      "\n\nCopy .env.example to .env and fill in the required values, " +
      "or set the variables in the Claude Desktop config 'env' block.";
    throw new Error(msg);
  }
  return parsed.data;
}
