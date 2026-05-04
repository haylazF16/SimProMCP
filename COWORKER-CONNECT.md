# Connect to the Goldman Simpro AI tool

This guide is for office staff connecting Claude Desktop to the office
Simpro tool. **No coding, no installations.** About 5 minutes total.

> **Heads up:** this works only when you're on the **office Wi-Fi or VPN**.
> If you need to use the tool from home without VPN, ask IT for the
> alternative individual setup instead.

---

## Part 1 — Get your own Simpro API key

Each person uses their own key so Simpro's audit log shows who did what.

1. Log into Simpro: <https://goldmanplumbingservices.simprosuite.com>
2. Click the **gear icon** (top right) → **System** → **Setup** → **API Keys**.
3. Click **Add**.
4. **Name it after yourself**, e.g. `Jane Smith - Claude Desktop`.
5. **Linked Employee:** choose **your own employee record**.
6. **Permissions:** start with **read-only**. IT can add edit later.
7. Click **Save**. Simpro shows the **Access Token** — a long string of
   letters and numbers.
8. **COPY THE TOKEN NOW** to a private note (Simpro shows it only once). If
   you lose it, you'll just create a new key — no big deal.

> **Important.** Treat the token like a password. Never email it, never
> paste it in a group chat, never include it in a screenshot. Send it only
> to IT (Tayfun / Sinan) and only via direct message.

---

## Part 2 — Send your Simpro API key to IT

In a direct message (not a group chat), send IT:

> Hi, here's my Simpro API key for the Claude tool: `<paste token here>`
> I work in: Plumbing only / Energy only / both

IT will reply with three things:

- **Plumbing URL** — looks like `http://<server-ip>:3001/mcp/plumbing`
- **Energy URL** — looks like `http://<server-ip>:3001/mcp/energy`
- **Your personal access token** — a long random string starting with
  `smcp_...`

> **Why two tokens?** Your **Simpro API key** stays on the office server —
> IT registers it for you. Your **personal access token** (the `smcp_...`
> one) is what your Claude Desktop sends to prove it's you. If you change
> PCs, IT just gives you a new personal token. Your Simpro key never has
> to leave the office.

---

## Part 3 — Add the connector to Claude Desktop

1. Open **Claude Desktop**.
2. Click the **profile circle / icon** (bottom-left of Claude Desktop) →
   **Settings**.
3. Click **Connectors** in the left sidebar.
4. Scroll down to **Add custom connector**.

   📷 *Screenshot here: Claude Desktop Settings → Connectors → Add custom connector button.*

5. Fill in **the first connector** (for Plumbing):
   - **Name:** `Goldman Plumbing`
   - **Remote MCP server URL:** the **Plumbing URL** IT sent you
   - **Authentication:** choose **Bearer token** and paste your **personal access token** (the one starting with `smcp_`)
6. Click **Add**.
7. **Repeat** for the Energy connector:
   - **Name:** `Goldman Energy`
   - **Remote MCP server URL:** the **Energy URL** IT sent you
   - **Authentication:** Bearer token = the same personal access token

> If you only need one company, just add that one.

> **Plan note.** Custom Connectors typically require **Claude Pro, Team, or
> Enterprise**. If your Claude Desktop doesn't show "Add custom connector",
> ask IT for the alternative individual setup (Plan B).

---

## Part 4 — Test it

In Claude Desktop, type:

> **Use Simpro Plumbing to test the connection.**

You should see something like:
> *"Simpro connection OK. Base URL: ..., Company ID: 4 ..."*

Then:

> **Use Simpro Energy to test the connection.**

Should report **Company ID: 37**.

If both work — **you're set**. 🎉

### Try these next

- *Use Simpro Plumbing to find customers named Goldman.*
- *Use Simpro Plumbing to show the 5 most recent jobs.*
- *Use Simpro Plumbing to list line items for purchase order [number].*
- *Use Simpro Energy to find supplier invoices from Reece in May 2026.*

---

## Safety — what's on and off by default

When you connect for the first time, Claude can **read** Simpro data
(search, view) but **cannot change anything**. This is on purpose.

If you need to create or update Simpro records, ask IT to enable writes
on your account. Even when enabled:
- Every write requires **`confirm: true`** in the request.
- The first dry-run period shows you exactly what would change before it
  actually happens.

If anything ever feels off, **just stop using the tool** until you've
talked to IT — there's no way to make permanent changes accidentally
during the safe period.

---

## Common problems and fixes

| Problem | Fix |
|---|---|
| Claude Desktop doesn't show "Add custom connector" | Your Claude plan likely doesn't support Custom Connectors. Ask IT for the alternative individual setup (Plan B). |
| The connector says "connection failed" | Check you're on office Wi-Fi or VPN. Try opening the URL in your browser — you should see "Simpro MCP server (HTTP transport)". |
| The connector says "401" or "Unauthorized" | Your personal access token is wrong, expired, or revoked. Ask IT to regenerate it. |
| You get "403" or "does not have access to energy" (or plumbing) | Your token only allows one company. Ask IT to grant access to both. |
| Claude finds zero quotes / jobs for a customer that clearly has them | Phrase the request as *"find quotes **for** customer X"* (not *"about"*). The tool searches the customer's records once it understands a customer is named. |
| Anything else | Send IT a screenshot. **Never include your access tokens in the screenshot** — blur them out first. |

---

## Rotating your tokens

If you suspect your token leaked, leave Goldman, or just want fresh
credentials:

- **Personal access token:** ask IT to revoke and regenerate. Takes 30 seconds.
- **Simpro API key:** log into Simpro, delete the old key, create a new one,
  send the new one to IT.

Do them in either order.

---

## Reaching IT

Currently: **Tayfun** / **Sinan**. When asking for help, include:

1. Which step you got stuck on.
2. The exact error message Claude or your browser showed.
3. Your Windows version.

**Never include your Simpro API key or `smcp_*` token in a screenshot or
message** — blur or crop them first.
