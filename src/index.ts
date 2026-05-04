#!/usr/bin/env node
// Entry point. Picks transport based on SIMPRO_TRANSPORT env var:
//   stdio (default) — Claude Desktop launches us as a subprocess
//   http            — long-running server, exposed over LAN
//
// The HTTP path is the LAN-server architecture. STDIO remains the
// default for backward compatibility with the Plan B installer.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { SimproClient } from "./simpro/client.js";
import { registerAllTools } from "./tools/index.js";

async function runStdio() {
  const config = loadConfig();
  const client = new SimproClient(config);

  const server = new McpServer({
    name: "simpro-mcp-server",
    version: "0.1.0",
  });

  registerAllTools(server, { client, config });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info(
    `simpro-mcp-server (STDIO) started. base=${config.SIMPRO_BASE_URL} company=${config.SIMPRO_COMPANY_ID} ` +
    `writes=${config.SIMPRO_ENABLE_WRITE_TOOLS} dryRun=${config.SIMPRO_DRY_RUN}`,
  );
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
  }

  if (config.SIMPRO_TRANSPORT === "http") {
    // Lazy-import so STDIO users don't pay the express startup cost.
    const { runHttp } = await import("./http/server.js");
    await runHttp({ config });
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
