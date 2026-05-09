// Load .env from the PROJECT ROOT (the folder containing dist/), not from
// the current working directory. When Claude Desktop spawns
// `node dist/index.js` it does so from an unpredictable cwd (often the
// user's home), so the default dotenv behaviour finds nothing.
//
// We explicitly point dotenv at <projectRoot>/.env. We also pass
// override:true so that values in this .env file take precedence over
// anything Claude Desktop's launcher injected via its own env block.
// This is important because claude_desktop_config.json sometimes gets
// auto-rewritten by the host app or by sync tools, whereas the .env
// file in the project folder is owned solely by us.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/config.js -> dist/.. -> project root
const PROJECT_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), override: true });

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
  // Transport selection. 'stdio' = legacy local mode (Claude Desktop launches
  // node as a subprocess). 'http' = LAN/server mode listening on a port.
  // Defaults to 'stdio' so the existing Plan B install behaviour is unchanged.
  SIMPRO_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),

  SIMPRO_BASE_URL: z
    .string()
    .url("SIMPRO_BASE_URL must be a full URL like https://yourcompany.simprosuite.com")
    .transform((u) => u.replace(/\/+$/, "")),
  // In HTTP mode SIMPRO_API_KEY can be empty if tokens.json provides per-user
  // keys. In STDIO mode it is required. We validate that conditionally below.
  SIMPRO_API_KEY: z.string().default(""),
  SIMPRO_COMPANY_ID: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => v.length > 0, "SIMPRO_COMPANY_ID is required"),
  SIMPRO_ENABLE_WRITE_TOOLS: boolFromString.default(false),
  SIMPRO_DRY_RUN: boolFromString.default(true),
  SIMPRO_REQUEST_TIMEOUT_MS: intFromString(30_000, 1_000, 600_000),
  SIMPRO_MAX_PAGE_SIZE: intFromString(100, 1, 1000),
  SIMPRO_DEFAULT_PAGE_SIZE: intFromString(25, 1, 1000),

  // HTTP mode tunables (ignored in STDIO mode).
  // Default bind 127.0.0.1 = localhost-only for safety. Set to 0.0.0.0 to
  // make the server reachable from other PCs on the LAN.
  SIMPRO_HTTP_HOST: z.string().default("127.0.0.1"),
  SIMPRO_HTTP_PORT: intFromString(3001, 1, 65535),
  // Path to tokens.json for per-user auth in HTTP mode.
  SIMPRO_TOKENS_FILE: z.string().default("./tokens.json"),
  // Audit log (one JSON object per line) of every authenticated tool call.
  SIMPRO_AUDIT_FILE: z.string().default("./audit.log"),

  // Public-facing base URL of this server, used as the OAuth issuer/baseUrl.
  // This is the URL coworkers see in their Claude Desktop Custom Connector,
  // INCLUDING scheme. e.g. https://goldman-ubuntu.tailf6f5cf.ts.net
  // (no trailing slash, no /mcp/* path).
  // If unset, falls back to http://<bind-host>:<port> which only works for
  // localhost testing. For production, set this in .env.
  SIMPRO_PUBLIC_BASE_URL: z.string().default(""),
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
  // STDIO mode requires a global API key (single-user). HTTP mode allows
  // per-user keys via tokens.json, so a global key is optional there.
  if (parsed.data.SIMPRO_TRANSPORT === "stdio" && parsed.data.SIMPRO_API_KEY.length < 8) {
    throw new Error(
      "SIMPRO_API_KEY is required in STDIO mode (must be at least 8 characters). " +
      "Set it in your .env or Claude Desktop config 'env' block.",
    );
  }
  return parsed.data;
}
