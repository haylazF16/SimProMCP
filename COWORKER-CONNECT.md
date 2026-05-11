# Connect to the Goldman Simpro AI tool

This guide is for office staff connecting Claude Desktop to the Goldman
Simpro AI tool. **No software to install — just two URLs and a token.**
About 5 minutes total. Works from office, home, café — anywhere with
internet.

## Architecture (one diagram)

```
┌─────────────┐  HTTPS public URL    ┌──────────────────┐  HTTPS   ┌──────────────┐
│  Your PC    │ ───────────────────▶ │  Goldman Server  │ ───────▶ │ Simpro Cloud │
│  Claude     │  goldman-ubuntu      │  /opt/simpro-mcp │ uses YOUR│ goldman      │
│  Desktop    │  .tail6b5a4b.ts.net  │  tokens.json     │ Simpro   │ plumbing     │
│             │  /mcp/plumbing       │  audit.log       │ key      │ services     │
│  + smcp_*   │  /mcp/energy         │                  │          │ .simprosuite │
│   token     │                      │                  │          │              │
└─────────────┘                      └──────────────────┘          └──────────────┘
```

The public URL is HTTPS-only. Authentication is a one-time OAuth consent
where you paste your personal token; after that Claude Desktop reuses it
automatically. The Goldman server uses **your** Simpro API key when
calling Simpro, so Simpro's audit log shows **your** name on every action.

---

## What you need before you start

- **Claude Desktop** installed on your PC (Windows or Mac).
- A **Claude paid plan** (Pro, Max, Team, or Enterprise). Custom Connectors
  are not available on the free plan.
- Internet connection (any — home, mobile hotspot, hotel Wi-Fi all work).

You do **not** need a VPN or Tailscale. The connection is HTTPS over the
public internet, secured by a personal token IT issues to you.

---

## Part 1 — Get your own Simpro API key

Each person uses their own key so Simpro's audit log shows who did what.

1. Log into Simpro: <https://goldmanplumbingservices.simprosuite.com>
2. Click the **gear icon** (top right) → **System** → **Setup** →
   **API Keys**.
3. Click **Add**.
4. **Name it after yourself**, e.g. `Jane Smith - Claude Desktop`.
5. **Linked Employee:** choose **your own employee record**.
6. **Permissions:** start with **read-only**. IT can grant edit later.
7. Click **Save**. Simpro shows the **Access Token** — a long string of
   letters and numbers.
8. **COPY THE TOKEN NOW** to a private note (Simpro shows it only once).
   If you lose it you'll just create a new key — no big deal.

> **Important.** Treat the token like a password. Never email it in plain
> text outside the company, never paste it in a group chat, never include
> it in a screenshot. Send it only to IT (Tayfun / Sinan) and only via
> direct message or our internal chat.

---

## Part 2 — Send your Simpro API key to IT

In a direct message (not a group chat) to **Tayfun** or **Sinan**, send:

> Hi, here's my Simpro API key for the Claude tool: `<paste token here>`
>
> I work in: Plumbing only / Energy only / both

IT will reply with:

- The **Plumbing URL**: `https://goldman-ubuntu.tail6b5a4b.ts.net/mcp/plumbing`
- The **Energy URL**: `https://goldman-ubuntu.tail6b5a4b.ts.net/mcp/energy`
- Your **personal access token** — a long random string starting with
  `smcp_...`

> **Why two tokens?** Your **Simpro API key** stays on the Goldman
> server — IT registers it for you. Your **personal access token** (the
> `smcp_...` one) is what your Claude Desktop uses to prove it's you.
> If you change PCs or suspect a leak, IT just gives you a new personal
> token. Your Simpro key never has to leave the company.

---

## Part 3 — Add the connector to Claude Desktop

1. Open **Claude Desktop**.
2. Click the **menu / profile icon** (top-left or bottom-left depending
   on version) → **Settings**.
3. Click **Connectors** in the left sidebar.
4. Scroll down and click **Add custom connector**.
5. Fill in **the first connector** (Plumbing):
   - **Name:** `Goldman Plumbing`
   - **Remote MCP server URL:** the **Plumbing URL** IT sent you
   - Leave the **Advanced settings** fields (OAuth Client ID, OAuth Client
     Secret) **EMPTY**.
6. Click **Add**.
7. The new connector appears in the list. Click **Connect** next to it.
8. Your default browser opens a Goldman consent page on
   `goldman-ubuntu.tail6b5a4b.ts.net`. **Paste your personal access token**
   (the `smcp_...` one) into the field and click **Authorize**.
9. The browser redirects back, and the connector now shows **Connected**.

10. **Repeat steps 4–9** for Energy:
    - **Name:** `Goldman Energy`
    - **Remote MCP server URL:** the **Energy URL** IT sent you
    - Same personal token on the consent page

> If you only need one company, just skip the second one.

> **The bearer token does NOT go in the "Add custom connector" dialog.**
> Leave both Advanced fields empty there. The token is pasted on the
> Goldman consent page that opens *after* you click Connect.

---

## Part 4 — Test it

In Claude Desktop, open a new chat and type:

> **Use Goldman Plumbing to test the connection.**

You should see something like:
> *"Simpro connection OK. Base URL: ..., Company ID: 4 ..."*

Then:

> **Use Goldman Energy to test the connection.**

Should report **Company ID: 37**.

If both work — **you're set**. 🎉

### Try these next

- *Use Goldman Plumbing to find customers named Goldman.*
- *Use Goldman Plumbing to show the 5 most recent jobs.*
- *Use Goldman Plumbing to list line items for purchase order [number].*
- *Use Goldman Energy to find supplier invoices from Reece in May 2026.*

---

## Safety — what's on and off by default

When you connect for the first time, Claude can **read** Simpro data
(search, view) but **cannot change anything**. This is on purpose.

If you need to create or update Simpro records, ask IT to enable writes
on your account. Even when enabled:

- Every write requires you to confirm before it happens.
- The first dry-run period shows you exactly what would change before it
  actually happens.

If anything ever feels off, **just stop using the tool** until you've
talked to IT — there's no way to make permanent changes accidentally
during the safe period.

---

## Common problems and fixes

| Problem | Fix |
|---|---|
| Claude Desktop doesn't show "Add custom connector" | Your Claude plan likely doesn't support Custom Connectors. Free plan won't work — needs Pro / Max / Team / Enterprise. |
| Browser shows "Your connection is not private" / certificate error | Disable "Use secure DNS" in your browser (Brave: Settings → Privacy → Use secure DNS = OFF). Then reload. |
| Consent page says "That token is not registered" | The personal token (smcp_...) was typed/pasted wrong, or IT hasn't issued one yet. Triple-check no spaces before/after, then ask IT to verify or re-issue. |
| Connector says "Authorization with the MCP server failed" | Click Connect again and re-do the consent. If it keeps failing, ask IT to check the server. |
| Connector says "403" or "does not have access to energy" (or plumbing) | Your token only allows one company. Ask IT to grant access to both. |
| Claude finds zero quotes / jobs for a customer that clearly has them | Phrase the request as *"find quotes **for** customer X"* (not *"about"*). |
| Anything else | Send IT a screenshot. **Never include your access tokens in the screenshot** — blur them out first. |

---

## Rotating your tokens

If you suspect your token leaked, leave Goldman, or just want fresh
credentials:

- **Personal access token (`smcp_...`):** ask IT to revoke and re-issue.
  Takes 30 seconds.
- **Simpro API key:** log into Simpro, delete the old key, create a new
  one, send the new one to IT.

Do them in either order.

---

## Reaching IT

Currently: **Tayfun** / **Sinan**. When asking for help, include:

1. Which step you got stuck on.
2. The exact error message Claude or your browser showed.
3. Your Windows / Mac version and your Claude Desktop plan (Pro / Max / Team).

**Never include your Simpro API key or `smcp_*` token in a screenshot or
message** — blur or crop them first.
