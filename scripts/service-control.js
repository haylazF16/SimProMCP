// Windows service control for the Simpro MCP HTTP server.
//
// Usage:
//   node scripts/service-control.js install
//   node scripts/service-control.js uninstall
//   node scripts/service-control.js start
//   node scripts/service-control.js stop
//   node scripts/service-control.js status
//
// Requires: node-windows installed locally (npm i node-windows --no-save)
// AND running this script from an elevated (Administrator) PowerShell.
//
// On install, the service is created with auto-start, runs as LocalSystem,
// and is configured to read environment variables from the system
// environment (which we set via setx in install-as-service.ps1 before
// calling this script).

import { Service, EventLogger } from "node-windows";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distEntry = path.join(projectRoot, "dist", "index.js");

if (!existsSync(distEntry)) {
  console.error(`ERROR: ${distEntry} not found. Run 'npm run build' first.`);
  process.exit(1);
}

const SERVICE_NAME = "GoldmanSimproMCP";
const SERVICE_DESCRIPTION =
  "Goldman Simpro MCP server - HTTP transport on the LAN. Restart Claude Desktop on each PC after starting.";

const svc = new Service({
  name: SERVICE_NAME,
  description: SERVICE_DESCRIPTION,
  script: distEntry,
  // Inherit the system environment. Admin must run setx (or
  // install-as-service.ps1) BEFORE installing the service to set
  // SIMPRO_TRANSPORT, SIMPRO_BASE_URL, SIMPRO_HTTP_HOST, etc.
  env: [
    { name: "SIMPRO_TRANSPORT", value: process.env.SIMPRO_TRANSPORT ?? "http" },
    { name: "SIMPRO_BASE_URL", value: process.env.SIMPRO_BASE_URL ?? "" },
    { name: "SIMPRO_COMPANY_ID", value: process.env.SIMPRO_COMPANY_ID ?? "4" },
    { name: "SIMPRO_HTTP_HOST", value: process.env.SIMPRO_HTTP_HOST ?? "0.0.0.0" },
    { name: "SIMPRO_HTTP_PORT", value: process.env.SIMPRO_HTTP_PORT ?? "3001" },
    { name: "SIMPRO_TOKENS_FILE", value: process.env.SIMPRO_TOKENS_FILE ?? path.join(projectRoot, "tokens.json") },
    { name: "SIMPRO_AUDIT_FILE", value: process.env.SIMPRO_AUDIT_FILE ?? path.join(projectRoot, "audit.log") },
    { name: "SIMPRO_DRY_RUN", value: process.env.SIMPRO_DRY_RUN ?? "true" },
  ],
  // Auto-restart if the process crashes.
  wait: 2,
  grow: 0.25,
  maxRestarts: 5,
});

const logger = new EventLogger({ source: SERVICE_NAME });

const action = process.argv[2];

const onError = (msg) => (err) => {
  console.error(`${msg}:`, err);
  logger.error(`${msg}: ${err}`);
  process.exit(1);
};

switch (action) {
  case "install":
    svc.on("install", () => {
      console.log(`Service '${SERVICE_NAME}' installed. Starting...`);
      svc.start();
    });
    svc.on("start", () => {
      console.log(`Service '${SERVICE_NAME}' is running.`);
      console.log(`Health: http://localhost:${process.env.SIMPRO_HTTP_PORT ?? "3001"}/healthz`);
      process.exit(0);
    });
    svc.on("alreadyinstalled", () => {
      console.log(`Service '${SERVICE_NAME}' is already installed. Use 'start' to (re)start it.`);
      process.exit(0);
    });
    svc.on("error", onError("Install error"));
    svc.install();
    break;

  case "uninstall":
    svc.on("uninstall", () => {
      console.log(`Service '${SERVICE_NAME}' uninstalled.`);
      process.exit(0);
    });
    svc.on("error", onError("Uninstall error"));
    svc.uninstall();
    break;

  case "start":
    svc.on("start", () => {
      console.log(`Service '${SERVICE_NAME}' started.`);
      process.exit(0);
    });
    svc.on("error", onError("Start error"));
    svc.start();
    break;

  case "stop":
    svc.on("stop", () => {
      console.log(`Service '${SERVICE_NAME}' stopped.`);
      process.exit(0);
    });
    svc.on("error", onError("Stop error"));
    svc.stop();
    break;

  case "status":
    console.log(`Service name: ${SERVICE_NAME}`);
    console.log(`Script:       ${distEntry}`);
    console.log("(Use Windows Services management console (services.msc) to see status.)");
    process.exit(0);
    break;

  default:
    console.error(`Unknown action: ${action}`);
    console.error("Usage: node scripts/service-control.js {install|uninstall|start|stop|status}");
    process.exit(2);
}
