// HTTP transport for the Simpro MCP server (per-user auth + per-company routing).
//
// Endpoints:
//   POST /mcp/plumbing  -> MCP for Goldman Plumbing Services (company id 4)
//   POST /mcp/energy    -> MCP for Goldman Energy             (company id 37)
//   GET  /healthz       -> liveness probe
//   GET  /              -> friendly text page
//
// Each request must carry a `Authorization: Bearer smcp_...` header. The token
// is looked up in tokens.json (path SIMPRO_TOKENS_FILE). The matched user
// record provides the Simpro API key actually used for the upstream call —
// so Simpro's audit log shows the real employee, not "API User".
//
// Per-request flow:
//   1. Authenticate bearer token
//   2. Verify user has companyAccess for the requested :company
//   3. Build a per-request Config:
//        - apiKey      = user's own Simpro API key
//        - companyId   = "4" or "37" depending on path
//        - writeEnabled= user's per-user flag (NOT the server's global)
//   4. Spin up a fresh McpServer + StreamableHTTPServerTransport pair
//      bound to that per-request Config and SimproClient
//   5. Hand off to the transport
//   6. Audit-log the user/company/method on the way out

import express, { type Request, type Response, type NextFunction, Router } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { Config } from "../config.js";
import { log, maskToken } from "../logger.js";
import { SimproClient } from "../simpro/client.js";
import { registerAllTools } from "../tools/index.js";
import {
  authenticate,
  COMPANY_IDS,
  CompanyKey,
  TokenRecord,
  touchTokenLastUsed,
} from "./tokens.js";
import { recordAudit } from "./audit.js";
import { RateLimiter } from "./rateLimit.js";
import { GoldmanOAuthProvider, attachConsentRoutes } from "./oauth.js";
import { attachUnenrollRoutes } from "./unenroll.js";
import { attachAdminRoutes } from "./admin.js";

export interface RunHttpOptions {
  config: Config;
}

/** Build a per-request Config that overrides the user's key/company/writes. */
function configForUser(global: Config, record: TokenRecord, company: CompanyKey): Config {
  return {
    ...global,
    SIMPRO_API_KEY: record.simproApiKey,
    SIMPRO_COMPANY_ID: COMPANY_IDS[company],
    SIMPRO_ENABLE_WRITE_TOOLS: record.writeEnabled === true,
    // Dry run respects the server-wide default unless we add a per-user
    // override later. Keep it as-is.
  };
}

/**
 * Best-effort extraction of the tool name from a JSON-RPC body for audit
 * logging. Body may be a single object or a batch array.
 */
function describeRpcMethod(body: unknown): { method: string; toolName?: string } {
  const one = (b: { method?: string; params?: { name?: string } }) => ({
    method: typeof b?.method === "string" ? b.method : "unknown",
    toolName: typeof b?.params?.name === "string" ? b.params.name : undefined,
  });
  if (Array.isArray(body)) return one(body[0] ?? {});
  return one((body as { method?: string; params?: { name?: string } }) ?? {});
}

export async function runHttp({ config }: RunHttpOptions): Promise<void> {
  const app = express();

  // Per-user MCP rate limiter (in-memory, resets on restart — acceptable:
  // a restart already interrupts any runaway loop).
  const mcpRateLimiter = new RateLimiter({
    windowMs: config.SIMPRO_RATE_WINDOW_MS,
    softLimit: config.SIMPRO_RATE_SOFT_LIMIT,
    hardLimit: config.SIMPRO_RATE_HARD_LIMIT,
  });
  const rateSweep = setInterval(
    () => mcpRateLimiter.sweep(),
    config.SIMPRO_RATE_WINDOW_MS,
  );
  rateSweep.unref(); // don't keep the process alive just for the sweep

  // We bind to 127.0.0.1 (or a Tailscale IP) and sit behind Tailscale Funnel,
  // which terminates TLS and forwards plaintext HTTP to us with X-Forwarded-*
  // headers. Trust ONLY loopback hops — `true` would honour any hop and let
  // a malicious upstream spoof client IP for rate-limiting.
  // (express-rate-limit needs this to read req.ip without throwing.)
  app.set("trust proxy", "loopback");

  // CORS: lock down to known origins. Browsers shouldn't be hitting most of
  // these endpoints (Claude Desktop is a native app), but the consent page
  // is browser-rendered so we allow same-origin and Anthropic's domains.
  // /healthz stays open below for ops tooling.
  const allowedOrigins = new Set<string>([
    "https://claude.ai",
    "https://www.claude.ai",
  ]);
  if (config.SIMPRO_PUBLIC_BASE_URL) {
    try { allowedOrigins.add(new URL(config.SIMPRO_PUBLIC_BASE_URL).origin); } catch { /* ignore */ }
  }
  app.use(
    cors({
      origin: (origin, cb) => {
        // Same-origin / native-app requests have no Origin header — allow.
        if (!origin) return cb(null, true);
        // Some browsers (Brave with strict shields, file:// pages, sandboxed
        // iframes) send `Origin: null` on same-site form POSTs. Auth is
        // enforced by the smcp_ cookie / Bearer token + SameSite=Strict, not
        // by CORS, so allowing "null" here is safe.
        if (origin === "null") return cb(null, true);
        if (allowedOrigins.has(origin)) return cb(null, true);
        // Localhost dev callbacks (any port).
        try {
          const u = new URL(origin);
          if (
            (u.protocol === "http:" || u.protocol === "https:") &&
            (u.hostname === "localhost" || u.hostname === "127.0.0.1")
          ) {
            return cb(null, true);
          }
        } catch { /* fall through */ }
        cb(new Error(`CORS: origin ${origin} not allowed`));
      },
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
      exposedHeaders: ["Mcp-Session-Id"],
    }),
  );
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false }));

  // ---- Request tracing for OAuth/MCP debugging --------------------------
  // Logs every hit on OAuth + discovery endpoints so we can diagnose
  // Claude Desktop's auth flow end-to-end. Cheap and high-signal — leave on.
  app.use((req, _res, next) => {
    const p = req.path;
    if (
      p === "/authorize" ||
      p === "/authorize/consent" ||
      p === "/token" ||
      p === "/register" ||
      p.startsWith("/.well-known/")
    ) {
      log.info(`[oauth-trace] ${req.method} ${p}${req.method === "GET" && Object.keys(req.query).length ? " ?" + new URLSearchParams(req.query as Record<string, string>).toString().slice(0, 200) : ""}`);
    }
    next();
  });

  // ---- OAuth 2.0 server (required by Claude Desktop's Custom Connector) ----
  // The provider validates user-pasted bearer tokens against tokens.json and
  // issues those same tokens as OAuth access tokens (one-time consent → reuse).
  // This bridges Claude Desktop's OAuth-only auth flow to our existing
  // bearer-token model with zero changes to tokens.json.
  const oauthProvider = new GoldmanOAuthProvider(config.SIMPRO_TOKENS_FILE);
  // Compute the issuer URL from the configured public-facing base. If
  // SIMPRO_PUBLIC_BASE_URL isn't set, fall back to a localhost guess so the
  // service still starts (admin can fix later).
  const issuerUrl = new URL(
    config.SIMPRO_PUBLIC_BASE_URL ||
    `http://${config.SIMPRO_HTTP_HOST}:${config.SIMPRO_HTTP_PORT}`,
  );

  // Rate-limit the bearer-paste endpoint. The token has 256 bits of entropy
  // so brute force isn't realistic, but a leaked-prefix or partially-known
  // token + a fast typing attacker should still be capped. 10 attempts per
  // 15 minutes per IP is plenty of head-room for a real user re-typing.
  const consentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: "Too many consent attempts. Wait 15 minutes and try again.",
  });

  const probeLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { valid: false, reason: "rate_limited" },
  });

  // Register our custom consent routes BEFORE mcpAuthRouter — Express picks
  // the first match, so our /authorize takes precedence over the SDK's.
  const oauthRouter = Router();
  // Apply the limiter only to the POST that submits the bearer.
  oauthRouter.post("/authorize/consent", consentLimiter);
  oauthRouter.post("/enroll/probe", probeLimiter);
  attachConsentRoutes(oauthRouter, oauthProvider, config);

  const unenrollLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: "Too many attempts. Wait 15 minutes.",
  });
  oauthRouter.post("/unenroll", unenrollLimiter);
  attachUnenrollRoutes(oauthRouter, config);
  app.use(oauthRouter);

  const adminLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: "Too many admin requests.",
  });
  const adminRouter = Router();
  adminRouter.use("/admin", adminLimiter);
  attachAdminRoutes(adminRouter, config);
  app.use(adminRouter);

  // SDK's auth router provides /token, /register, /.well-known/* — for
  // /authorize, we already attached our own above which returns the consent
  // page. The SDK router's /authorize never gets hit because Express matches
  // ours first.
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      resourceName: "Goldman Simpro MCP",
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "simpro-mcp-server",
      transport: "http",
      version: "0.1.0",
      // Note: globalWriteEnabled is for ops visibility only; per-user write
      // is decided from the user's tokens.json record at call time.
      globalDryRun: config.SIMPRO_DRY_RUN,
    });
  });

  app.get("/", (_req, res) => {
    res.type("text/plain").send(
      [
        "Simpro MCP server (HTTP transport).",
        "",
        "Endpoints:",
        "  POST /mcp/plumbing  - MCP for Goldman Plumbing Services",
        "  POST /mcp/energy    - MCP for Goldman Energy",
        "  GET  /healthz       - liveness probe",
        "",
        "Auth: Authorization: Bearer smcp_<token>",
        "Connect from Claude Desktop via Settings > Connectors > Add custom connector.",
      ].join("\n"),
    );
  });

  // ---- The MCP endpoint -------------------------------------------------
  const handleMcp = (company: CompanyKey) => async (req: Request, res: Response) => {
    const t0 = Date.now();
    const auth = authenticate(config.SIMPRO_TOKENS_FILE, req.headers["authorization"]);
    if (!auth.ok) {
      log.warn(`HTTP ${req.method} ${req.path} -> ${auth.status} ${auth.reason}`);
      res.status(auth.status).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: `Auth failed: ${auth.reason}` },
        id: null,
      });
      return;
    }

    if (!auth.record.companyAccess.includes(company)) {
      log.warn(`HTTP ${auth.record.name} denied access to ${company} (allowed: ${auth.record.companyAccess.join(",")})`);
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: `Your token does not have access to ${company}` },
        id: null,
      });
      return;
    }

    const verdict = mcpRateLimiter.check(auth.token);
    if (verdict === "hard") {
      log.warn(`[rate] HARD user=${auth.record.name.replace(/[\r\n\t]/g, " ").slice(0, 80)} company=${company}`);
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32004, message: "Rate limit exceeded — wait a few minutes and try again." },
        id: null,
      });
      return;
    }
    if (verdict === "soft") {
      log.warn(`[rate] SOFT user=${auth.record.name.replace(/[\r\n\t]/g, " ").slice(0, 80)} company=${company}`);
    }

    const userConfig = configForUser(config, auth.record, company);
    const client = new SimproClient(userConfig);

    const server = new McpServer(
      { name: `simpro-mcp-server (${company})`, version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerAllTools(server, { client, config: userConfig });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableDnsRebindingProtection: false,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    // Audit log (best-effort, fire-and-forget). Captures who called which
    // tool against which company. Result/duration is captured after the
    // transport handles the request.
    const rpc = describeRpcMethod(req.body);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      // Touch lastUsedAt + audit on success.
      touchTokenLastUsed(config.SIMPRO_TOKENS_FILE, auth.token);
      if (rpc.method === "tools/call" && rpc.toolName) {
        recordAudit(config.SIMPRO_AUDIT_FILE, {
          user: auth.record.name,
          company,
          tool: rpc.toolName,
          ok: true,
          durationMs: Date.now() - t0,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`HTTP /mcp/${company} handler error for ${auth.record.name}: ${maskToken(msg)}`);
      if (rpc.method === "tools/call" && rpc.toolName) {
        recordAudit(config.SIMPRO_AUDIT_FILE, {
          user: auth.record.name,
          company,
          tool: rpc.toolName,
          ok: false,
          durationMs: Date.now() - t0,
          errorMessage: msg.slice(0, 200),
        });
      }
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  app.post("/mcp/plumbing", handleMcp("plumbing"));
  app.post("/mcp/energy", handleMcp("energy"));

  // 405 Method Not Allowed for GET/DELETE on the MCP endpoints (stateless mode).
  for (const method of ["get", "delete"] as const) {
    app[method](["/mcp/plumbing", "/mcp/energy"], (_req, res) => {
      res
        .status(405)
        .set("Allow", "POST")
        .json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Stateless server: only POST is supported" },
          id: null,
        });
    });
  }

  // 404 with a hint for any other /mcp/... path.
  app.all(/^\/mcp\/.*/, (_req, res) => {
    res.status(404).json({
      error: "Unknown endpoint. Use /mcp/plumbing or /mcp/energy.",
    });
  });

  // Generic error catcher so we never leak stack traces.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error(`[srv-error] Unhandled HTTP error: ${maskToken(err.message)}`);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  });

  process.on("uncaughtException", (err) => {
    log.error(`[fatal] uncaughtException: ${maskToken(err instanceof Error ? (err.stack ?? err.message) : String(err))}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error(`[fatal] unhandledRejection: ${maskToken(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))}`);
    process.exit(1);
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(config.SIMPRO_HTTP_PORT, config.SIMPRO_HTTP_HOST, () => {
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : "?";
      log.info(`simpro-mcp-server (HTTP) listening on http://${bound}`);
      log.info(`  endpoints: POST /mcp/plumbing, POST /mcp/energy`);
      log.info(`  tokens:    ${config.SIMPRO_TOKENS_FILE}`);
      log.info(`  audit:     ${config.SIMPRO_AUDIT_FILE}`);
      if (config.SIMPRO_HTTP_HOST === "127.0.0.1") {
        log.info("  bind:      127.0.0.1 (localhost-only). Set SIMPRO_HTTP_HOST=0.0.0.0 for LAN access.");
      }
    });
    server.on("error", reject);
    const shutdown = () => {
      log.info("Shutting down HTTP server...");
      server.close(() => resolve());
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
