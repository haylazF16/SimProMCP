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
where you paste your Simpro API key; after that Claude Desktop reuses
the issued token automatically. The Goldman server uses **your** Simpro API
key when calling Simpro, so Simpro's audit log shows **your** name on every
action.

---

## What you need before you start

- **Claude Desktop** installed on your PC (Windows or Mac).
- A **Claude paid plan** (Pro, Max, Team, or Enterprise). Custom Connectors
  are not available on the free plan.
- Internet connection (any — home, mobile hotspot, hotel Wi-Fi all work).

You do **not** need a VPN or Tailscale. The connection is HTTPS over the
public internet, secured by your personal Simpro API key.

---

## Part 1 — Get your Simpro API key (2 minutes)

Each person uses their own Simpro key so Simpro's audit log shows who did what.

1. Log into Simpro: <https://goldmanplumbingservices.simprosuite.com>
2. Click the **gear icon** (top right) → **System** → **Setup** → **API Keys** → **Add**.
3. Name it after yourself, e.g. `Jane Smith - Claude Desktop`.
4. Linked Employee: choose your own employee record.
5. Permissions: read-only is fine to start.
6. Click **Save**. Simpro shows the **Access Token** — a long string. **Copy it now** — Simpro shows it only once.

Treat this token like a password. Save it in your password manager.

## Part 2 — Add the connector in Claude Desktop (1 minute)

1. Open **Claude Desktop**.
2. Menu icon (top-left or profile circle) → **Settings** → **Connectors**.
3. Scroll down → **Add custom connector**.
4. Fill in:
   - **Name:** `Goldman Plumbing`
   - **Remote MCP server URL:** `https://goldman-ubuntu.tail6b5a4b.ts.net/mcp/plumbing`
   - Leave the **Advanced settings** fields (OAuth Client ID, OAuth Client Secret) **empty**.
5. Click **Add**.
6. (Optional) Repeat with Name `Goldman Energy` and URL ending in `/mcp/energy`.

## Part 3 — Connect (1 minute)

1. Click **Connect** on the new connector. Your default browser opens a Goldman page.
2. The page asks for your **Simpro API key** (the one from Part 1) and your **name**.
3. Paste the key, check your name (auto-detected), click **Authorize**.
4. The browser returns to Claude Desktop and the connector shows **Connected**.
5. If you added Energy too, do the same for it.

**No second token. No emailing IT. No waiting.**

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

## Safety — what to know about writes

You can **read AND write** Simpro records from the moment you connect — the
same as your access through Simpro's own web UI. The AI tool doesn't grant
any extra permissions; it just exposes what your Simpro account already
allows through a chat interface.

Two practical safety nets you should rely on:

1. **Every write asks you to confirm before it happens.** The tool tells you
   exactly what it's about to do (job number, status change, line items,
   etc.) and waits for your "yes." If you don't confirm, nothing changes
   in Simpro.

2. **Read carefully before confirming.** AI tools occasionally misinterpret
   ambiguous requests. If something looks wrong in the preview — different
   customer, wrong line item, unexpected status — say "no" or "let me
   check" and the action is cancelled.

If you want to operate in a stricter mode (e.g., simulate writes without
actually changing anything), ask IT to enable dry-run for your account.
Dry-run shows the planned change without committing.

If anything ever feels wrong, **just stop using the tool** and message IT.

---

## Common problems and fixes

| Problem | Fix |
|---|---|
| Claude Desktop doesn't show "Add custom connector" | Your Claude plan likely doesn't support Custom Connectors. Free plan won't work — needs Pro / Max / Team / Enterprise. |
| Browser shows "Your connection is not private" / certificate error | Disable "Use secure DNS" in your browser (Brave: Settings → Privacy → Use secure DNS = OFF). Then reload. |
| Page says "Simpro rejected that API key" | The Simpro key was typed/pasted wrong, or it was deleted in Simpro. Generate a fresh one (Part 1) and try again. |
| Page says "no access to Goldman companies" | Your Simpro user account doesn't have access to company 4 or 37. Ask Simpro IT (Tayfun) to grant access. |
| Page says "Couldn't reach Simpro" | Simpro's API is slow or down. Wait a minute and retry. |
| Connector says "Authorization with the MCP server failed" | Click Connect again and re-do the consent. If it keeps failing, ask IT to check the server. |
| Connector says "403" or "does not have access to energy" (or plumbing) | Your token only allows one company. Ask IT to grant access to both. |
| Claude finds zero quotes / jobs for a customer that clearly has them | Phrase the request as *"find quotes **for** customer X"* (not *"about"*). |
| Anything else | Send IT a screenshot. **Never include your access tokens in the screenshot** — blur them out first. |

---

## Rotating your tokens

If you suspect your Simpro key leaked, leave Goldman, or just want fresh
credentials:

- Log into Simpro, delete the old key, create a new one.
- Re-click **Connect** in Claude Desktop and paste the new Simpro key.

If you want to completely remove your AI tool access:

- Open <https://goldman-ubuntu.tail6b5a4b.ts.net/unenroll> in your browser.
- Paste your current Simpro key. Click Remove.

---

## Reaching IT

Currently: **Tayfun** / **Sinan**. When asking for help, include:

1. Which step you got stuck on.
2. The exact error message Claude or your browser showed.
3. Your Windows / Mac version and your Claude Desktop plan (Pro / Max / Team).

**Never include your Simpro API key or `smcp_*` token in a screenshot or
message** — blur or crop them first.
