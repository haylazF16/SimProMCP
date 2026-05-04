// HTTP transport for the Simpro MCP server.
//
// Architecture (this commit — foundation only):
//   - Stateless Streamable-HTTP MCP endpoint at /mcp
//   - Each POST creates a fresh McpServer + StreamableHTTPServerTransport
//     pair, registers the 57 tools using the GLOBAL config (single-tenant
//     for now), and tears them down when the response closes.
//   - Per-user authentication (tokens.json -> per-request Simpro API key)
//     is the NEXT commit. This commit just gets the transport working.
//
// Why per-request fresh server: it isolates concurrent calls from each
// other and makes the path to per-user trivial (just swap the Config
// passed in based on the bearer token). The cost is ~1-2ms of tool-
// registration work per request, negligible for our usage.

import express, { type Request, type Response } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Config } from "../config.js";
import { log } from "../logger.js";
import { SimproClient } from "../simpro/client.js";
import { registerAllTools } from "../tools/index.js";

export interface RunHttpOptions {
  config: Config;
}

export async function runHttp({ config }: RunHttpOptions): Promise<void> {
  const app = express();

  // Permissive CORS for LAN. Locked-down origin lists can be added later
  // once we know which client (Claude Desktop) origins to allow.
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
      exposedHeaders: ["Mcp-Session-Id"],
    }),
  );
  app.use(express.json({ limit: "4mb" }));

  // Liveness probe — handy when running as a Windows service.
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "simpro-mcp-server",
      transport: "http",
      writeEnabled: config.SIMPRO_ENABLE_WRITE_TOOLS,
      dryRun: config.SIMPRO_DRY_RUN,
    });
  });

  // Friendly root page so a coworker pasting the URL into a browser sees
  // something useful instead of "Cannot GET /".
  app.get("/", (_req, res) => {
    res.type("text/plain").send(
      "Simpro MCP server (HTTP transport).\n" +
      "  POST /mcp     — MCP JSON-RPC endpoint (use a Claude Desktop Custom Connector)\n" +
      "  GET  /healthz — liveness probe\n",
    );
  });

  // ---- The MCP endpoint -------------------------------------------------
  app.post("/mcp", async (req: Request, res: Response) => {
    // Build a fresh server + transport per request (stateless mode).
    const client = new SimproClient(config);
    const server = new McpServer(
      { name: "simpro-mcp-server", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerAllTools(server, { client, config });

    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session ID generation, every request fully self-contained.
      sessionIdGenerator: undefined,
      // DNS-rebinding protection: Streamable HTTP recommends checking Origin/Host
      // headers when running locally. For LAN use we leave this open (cors handles it),
      // but enable allowedHosts later if running publicly.
      enableDnsRebindingProtection: false,
    });

    // Tear down when the client disconnects.
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error(
        "HTTP /mcp handler error",
        err instanceof Error ? err.message : String(err),
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET and DELETE on /mcp are part of stateful Streamable HTTP. In stateless
  // mode we just return Method Not Allowed so clients fall back cleanly.
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", (_req, res) => {
      res
        .status(405)
        .set("Allow", "POST")
        .json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Stateless server: only POST /mcp is supported" },
          id: null,
        });
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(config.SIMPRO_HTTP_PORT, config.SIMPRO_HTTP_HOST, () => {
      const addr = server.address();
      const bound =
        typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : "?";
      log.info(
        `simpro-mcp-server (HTTP) listening on http://${bound} ` +
        `(company=${config.SIMPRO_COMPANY_ID}, writes=${config.SIMPRO_ENABLE_WRITE_TOOLS}, dryRun=${config.SIMPRO_DRY_RUN})`,
      );
      if (config.SIMPRO_HTTP_HOST === "127.0.0.1") {
        log.info(
          "Bound to 127.0.0.1 (localhost-only). To expose to the LAN, set SIMPRO_HTTP_HOST=0.0.0.0",
        );
      }
    });
    server.on("error", reject);
    // Graceful shutdown on SIGINT/SIGTERM.
    const shutdown = () => {
      log.info("Shutting down HTTP server...");
      server.close(() => resolve());
      // Hard exit after 3s if connections refuse to close.
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
