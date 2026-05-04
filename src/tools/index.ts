import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCustomerTools } from "./customers.js";
import { registerSiteTools } from "./sites.js";
import { registerJobTools } from "./jobs.js";
import { registerQuoteTools } from "./quotes.js";
import { registerInvoiceTools } from "./invoices.js";
import { registerTaskTools } from "./tasks.js";
import { registerNoteTools } from "./notes.js";
import { registerSupplierTools } from "./suppliers.js";
import { registerInventoryTools } from "./inventory.js";
import { registerContactTools } from "./contacts.js";
import { registerSchedulingTools } from "./scheduling.js";
import { registerFinancialsTools } from "./financials.js";
import type { ToolCtx } from "./_shared.js";

export function registerAllTools(server: McpServer, ctx: ToolCtx) {
  registerCustomerTools(server, ctx);
  registerSiteTools(server, ctx);
  registerJobTools(server, ctx);
  registerQuoteTools(server, ctx);
  registerInvoiceTools(server, ctx);
  registerTaskTools(server, ctx);
  registerNoteTools(server, ctx);
  registerSupplierTools(server, ctx);
  registerInventoryTools(server, ctx);
  registerContactTools(server, ctx);
  registerSchedulingTools(server, ctx);
  registerFinancialsTools(server, ctx);
}
