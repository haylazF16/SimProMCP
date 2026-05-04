# simpro-mcp-server

> Pick the doc that matches your role:
>
> | Role | Read | What it covers |
> |---|---|---|
> | IT / admin (LAN server, recommended) | **[SERVER-SETUP.md](SERVER-SETUP.md)** | Install the HTTP server as a Windows service, manage users with `tokens.json`, audit log, migrate to a new server PC later. |
> | Coworker connecting to the LAN server | **[COWORKER-CONNECT.md](COWORKER-CONNECT.md)** | Get a Simpro API key, add a Custom Connector in Claude Desktop. ~5 min. |
> | Coworker doing standalone Plan B install | **[SETUP-GUIDE.md](SETUP-GUIDE.md)** | Install on each PC. STDIO version (no server needed). |
> | IT distributing Plan B installer | **[ROLLOUT-CHECKLIST.md](ROLLOUT-CHECKLIST.md)** | Build the share folder, push updates, security checklist. |
>
> This README is the technical reference for whoever maintains the code.

A local **Model Context Protocol (MCP)** server that lets **Claude Desktop** read,
create, and update data in your **Simpro CRM** account using Simpro's official
REST API and your own API key.

> Plain English: this is a small program that runs on your Windows PC. Claude
> Desktop talks to it, and it talks to Simpro on your behalf — so you can ask
> Claude things like "find recent jobs for customer ABC" and it actually
> answers from your live Simpro data.

---

## What you need

1. **Windows 10/11**.
2. **Node.js 18.17 or newer**. Download from <https://nodejs.org> and run the
   installer (accept defaults).
3. **Claude Desktop** for Windows (<https://claude.ai/download>).
4. A **Simpro API key** with permission to read (and optionally write) the data
   you care about. You can generate one in Simpro:
   `System ▸ Setup ▸ System ▸ API Keys` (or ask your Simpro admin).
5. Your **Simpro base URL** — looks like `https://YOURCOMPANY.simprosuite.com`.
6. Your **Simpro company ID** — usually a small number such as `0` or `1`.
   Confirm in Simpro before assuming.

---

## What is MCP?

MCP is a small protocol Claude Desktop uses to talk to "tools" running on your
machine. This project is one of those tools. Claude sends a request like
*"search Simpro customers for ABC"* and we turn it into a real Simpro API call.

---

## Install (one-time)

Open **PowerShell** in this folder (Shift + Right-click → *Open PowerShell window here*).

```powershell
npm install
npm run build
```

That produces a `dist/` folder containing the compiled server (`dist/index.js`).

---

## Configure your credentials

Copy the template and fill in your values:

```powershell
Copy-Item .env.example .env
notepad .env
```

Example `.env`:

```env
SIMPRO_BASE_URL=https://YOURCOMPANY.simprosuite.com
SIMPRO_API_KEY=your_api_key_here
SIMPRO_COMPANY_ID=0

# Safety: leave these as-is until you're ready
SIMPRO_ENABLE_WRITE_TOOLS=false
SIMPRO_DRY_RUN=true
```

> **Verified Goldman Plumbing values (May 2026 live test):**
> ```
> SIMPRO_BASE_URL=https://goldmanplumbingservices.simprosuite.com
> SIMPRO_COMPANY_ID=4
> ```
> The tenant has multiple companies: `0` Template, `4` Goldman Plumbing
> Services Pty Ltd, `37` Goldman Energy Pty Ltd. Pick the one whose data you
> want to read/write.

**Never commit your `.env` file.** It's already in `.gitignore`.

You can run the server two ways: with a `.env` file (good for `npm start`),
or with values in the Claude Desktop config (recommended for normal use —
Claude Desktop launches the server itself). You don't need both.

---

## Test the server outside Claude (optional but recommended)

```powershell
npm start
```

It should print a startup line on stderr like
`[info] simpro-mcp-server started. base=https://... company=...` and then sit
waiting on stdin. Press **Ctrl+C** to stop.

For interactive testing, the official MCP Inspector is great:

```powershell
npx @modelcontextprotocol/inspector node dist/index.js
```

Then in the inspector UI try these tools first:

- `simpro_get_company_info` — confirms your API key + base URL + company ID work.
- `simpro_search_customers` with `query: "test"`.
- `simpro_get_customer` with a real `customerId`.

---

## Connect to Claude Desktop

1. Find the Claude Desktop config file. Open the **Run** dialog (`Win + R`) and paste:

   ```
   %APPDATA%\Claude\claude_desktop_config.json
   ```

   If the file does not exist, create it with the contents below.

2. Add this `mcpServers` entry. **Use the real path to your `dist/index.js`**
   (replace `C:\\Path\\To\\...` with your actual path; backslashes must be doubled in JSON):

   ```json
   {
     "mcpServers": {
       "simpro": {
         "command": "node",
         "args": [
           "C:\\Path\\To\\simpro-mcp-server\\dist\\index.js"
         ],
         "env": {
           "SIMPRO_BASE_URL": "https://YOURCOMPANY.simprosuite.com",
           "SIMPRO_API_KEY": "your_api_key_here",
           "SIMPRO_COMPANY_ID": "0",
           "SIMPRO_ENABLE_WRITE_TOOLS": "false",
           "SIMPRO_DRY_RUN": "true"
         }
       }
     }
   }
   ```

   If you already have `mcpServers` for other tools, just add `"simpro": { ... }`
   inside it — don't create a second `mcpServers` block.

3. **Save** the file, then **fully quit and restart Claude Desktop** (right-click
   the tray icon → Quit, then reopen). Re-launching the window is not enough.

4. In Claude Desktop, you should see a small tools icon near the message box.
   It should list `simpro` tools.

---

## First test prompts to try in Claude Desktop

1. *"Use Simpro to test the connection."* → calls `simpro_get_company_info`.
2. *"Use Simpro to search for customers named Goldman."*
3. *"Use Simpro to get customer 1."*
4. *"Use Simpro to find recent jobs."*
5. *"Use Simpro to dry-run creating a customer named Test Co with email test@example.com — confirm true."*

If a write tool is called while writes are disabled, Claude will receive a
clear message telling you to flip the safety flag.

---

## Enabling write tools (create / update)

Write tools are **disabled by default**. To enable them:

1. Set `SIMPRO_ENABLE_WRITE_TOOLS=true` (in `.env` *or* Claude Desktop config).
2. Keep `SIMPRO_DRY_RUN=true` for the first round of testing. With dry-run on,
   tools show you the exact API call they *would* make, but never actually send
   it. Read the previews carefully.
3. When you're confident, set `SIMPRO_DRY_RUN=false`.
4. Every write tool also needs `confirm: true` in its arguments. Without it,
   the tool returns a confirmation request — no API call is made.

> Restart Claude Desktop any time you change the config.

---

## Each user uses their own API key

Every coworker who wants to use this server should:

1. Generate **their own** API key in Simpro (don't share keys).
2. Put it in **their** `claude_desktop_config.json` under `env.SIMPRO_API_KEY`.

This way each person's actions show up under their own Simpro user, and revoking
one person's access doesn't affect anyone else.

To **rotate** your key, generate a new one in Simpro, paste it into your config,
restart Claude Desktop, and revoke the old key in Simpro.

---

## Available tools (54 total)

### Read (always on)

**Core records:**

- `simpro_get_company_info` — connection test + show configured company ID.
- `simpro_search_customers` — search by keyword, paginated.
- `simpro_get_customer` — full customer record by ID.
- `simpro_search_sites` — search sites, optionally by customer.
- `simpro_get_site` — full site record by ID.
- `simpro_search_jobs` — search jobs with filters (customer, site, status, dates).
- `simpro_get_job` — full job record by ID.
- `simpro_search_quotes` — search quotes with filters.
- `simpro_get_quote` — full quote record by ID.
- `simpro_search_invoices` — search invoices with filters.
- `simpro_get_invoice` — full invoice record by ID.

**Suppliers (called "vendors" in the API):**

- `simpro_search_suppliers` — by name, paginated.
- `simpro_get_supplier` — full record (address, banking, ABN, payment terms).
- `simpro_search_purchase_orders` — POs by `supplierName`/`supplierId`/stage/date.
- `simpro_get_purchase_order` — full PO with items, job link, totals.
- `simpro_search_supplier_invoices` — supplier invoices by `supplierName`/date.
- `simpro_get_supplier_invoice` — full invoice (auto-resolves parent vendor order).

**Parts / inventory:**

- `simpro_search_catalog` — by part Name (`query`) or `partNo` substring.
- `simpro_get_catalog_item` — full catalog detail (prices, tax, group, UOM).
- `simpro_search_storage_devices` — warehouses, vehicles, vans.
- `simpro_get_storage_device` — full storage device record.
- `simpro_search_stock_takes` — stocktake history (filter by storage device).
- `simpro_get_stock_take` — full stocktake record.

**CRM:**

- `simpro_search_contacts` / `simpro_get_contact` — people attached to customers/sites.
- `simpro_search_leads` / `simpro_get_lead` — sales leads (your tenant has 0 currently).

**Scheduling:**

- `simpro_search_schedules` — staff schedule blocks (filter by staff/date).
- `simpro_search_timesheets` — recorded labour hours and cost.
- `simpro_search_recurring_jobs` / `simpro_get_recurring_job` — PM contract templates.

**Financials:**

- `simpro_search_customer_payments` — money received from customers.
- `simpro_search_credit_notes` / `simpro_get_credit_note` — issued credits.
- `simpro_search_recurring_invoices` — recurring invoice templates.

### Discovery (always on, useful before creating jobs/quotes)

- `simpro_list_job_statuses`
- `simpro_list_job_types`
- `simpro_list_quote_statuses`
- `simpro_list_quote_types`
- `simpro_list_staff`
- `simpro_list_cost_centres`

### Create (gated by `SIMPRO_ENABLE_WRITE_TOOLS` + `confirm: true`)

- `simpro_create_customer`
- `simpro_create_site`
- `simpro_create_job` — needs `customerId`, `siteId`, `description`. Many
  Simpro tenants also need `jobType` (Type ID), `status` (Status ID), and a
  cost-centre/section structure — find IDs with the discovery tools above and
  pass them via `rawPayload` if your tenant requires non-default fields.
- `simpro_create_quote`
- `simpro_create_task`
- `simpro_create_supplier`
- `simpro_add_job_note`

### Update (gated)

- `simpro_update_customer`
- `simpro_update_site`
- `simpro_update_job`
- `simpro_update_quote`
- `simpro_update_task`
- `simpro_update_supplier` (use `archived: true` to soft-delete)

> Only fields you provide are sent (PATCH semantics). Empty fields are dropped,
> never overwritten.

### `rawPayload` escape hatch

Every create/update tool accepts an optional `rawPayload` argument. If provided,
it bypasses our simplified field mapping and sends your exact JSON to Simpro.
Use this when your tenant needs fields we don't expose.

---

## Safety notes

- All write tools require **explicit `confirm: true`**. No `confirm`, no API call.
- Set `SIMPRO_DRY_RUN=true` to preview every write without sending it.
- Set `SIMPRO_ENABLE_WRITE_TOOLS=false` to disable creates/updates entirely.
- **No delete tools** are implemented in this version.
- Logs go to stderr only. The MCP protocol uses stdout, and stray stdout output
  will break Claude's connection.
- Tokens are masked in error logs. Don't paste log output containing your key
  into chats or issue trackers without checking first.

---

## Troubleshooting

**Claude doesn't show the Simpro tool.**
Did you fully quit Claude Desktop (tray icon → Quit) and reopen? Did you save
the JSON file with valid syntax (no trailing commas, double-backslash paths)?
Try opening the file in VS Code — it will highlight syntax errors.

**"401 Unauthorized" / "API key invalid".**
The API key in your config is wrong, expired, or was revoked. Generate a new
one in Simpro and update your config. Make sure there are no extra spaces.

**"403 Forbidden".**
The key works but lacks permission for that resource. Check the Simpro user's
role/permissions.

**"404 Not found" on every call.**
Most likely `SIMPRO_COMPANY_ID` is wrong, or your tenant uses a different API
version. Edit `src/simpro/endpoints.ts` (the `API_VERSION` constant and the
endpoint paths) and rebuild with `npm run build`.

**"Could not reach Simpro".**
Check `SIMPRO_BASE_URL` (no trailing slash, correct subdomain) and that you can
visit it in a browser.

**Job creation fails saying a field is missing.**
Simpro's job model is strict. Run `simpro_list_job_types`,
`simpro_list_job_statuses`, and `simpro_list_cost_centres` to find the IDs
you need, then use `rawPayload` to pass them.

**JSON config syntax error on Claude Desktop startup.**
Open `%APPDATA%\Claude\claude_desktop_config.json` in VS Code or any JSON
linter and fix the highlighted issue. Common: missing comma, single quotes
instead of double, single backslashes in paths.

**"stdout logging breaking MCP".**
This server logs to stderr only. If you fork the code, never use
`console.log` in `src/` — use the `log` helper in `src/logger.ts`.

---

## How to update the auth header style

Simpro's API key workflow defaults to `Authorization: Bearer <token>` and that
is what this server sends. If your tenant requires a different shape, edit
**one** function: `buildAuthHeaders` in `src/simpro/client.ts`. Comments there
list the alternatives. Run `npm run build` after the change.

---

## Future work (not implemented)

### Delete tools (planned, not built)

When delete tools are added later, they will:
- be **disabled by default** behind a separate `SIMPRO_ENABLE_DELETE_TOOLS=true` flag,
- require `confirm: true`,
- require an explicit record ID — no bulk delete,
- always run dry-run on first invocation, requiring a second `dryRun: false`
  call to actually delete,
- return a summary of the deleted record so it's auditable.

Until then, deletes must be done in Simpro's UI.

### OAuth2 (planned)

Simpro also supports OAuth2 for multi-user / web app scenarios. The current
server only uses API-key auth. OAuth support could be added later by extending
`SimproClient.buildAuthHeaders` and adding a token-refresh flow.

---

## Project layout

```
package.json
tsconfig.json
.env.example
.gitignore
README.md
src/
  index.ts                  ← MCP server entry point
  config.ts                 ← env validation
  logger.ts                 ← stderr-only logger + token masking
  simpro/
    client.ts               ← HTTP client (auth, retries, timeout)
    errors.ts               ← typed errors
    endpoints.ts            ← all Simpro paths in one place
    types.ts                ← loose response shapes
  tools/
    customers.ts  sites.ts  jobs.ts
    quotes.ts     invoices.ts  tasks.ts  notes.ts
    _shared.ts              ← writeGuard, safeRun, formatters
    index.ts                ← registerAllTools
  utils/
    schemas.ts  pagination.ts  sanitise.ts
```

---

## Scripts

| Command          | What it does                                          |
| ---------------- | ----------------------------------------------------- |
| `npm install`    | Install dependencies                                  |
| `npm run build`  | Compile TypeScript to `dist/`                         |
| `npm run typecheck` | Type-check only, no output                         |
| `npm run dev`    | Run from source via `tsx` (no build step needed)      |
| `npm start`      | Run the compiled server (`node dist/index.js`)        |
