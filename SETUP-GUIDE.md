# Simpro + Claude Desktop — Plan B Setup Guide

**Who this is for:** office staff at Goldman who can't use the LAN server
version (e.g. you're on Free Claude, or you need to work from home without
VPN). This guide installs the Simpro tool **directly on your PC**.

If your Claude plan supports Custom Connectors, **use COWORKER-CONNECT.md
instead** — it's simpler.

> ⏱ **Time:** about 5–10 minutes with the installer (Part 0 below).
> ✅ **You will need:** a Goldman Simpro login that can create API keys (or an
> admin who can create one for you), a Windows PC, Claude Desktop installed,
> and Node.js installed.

## Architecture (one diagram)

```
┌──────────────────────────────────┐    HTTPS   ┌───────────────────┐
│  Your PC                         │  uses YOUR │  Simpro Cloud     │
│  Claude Desktop                  │  Simpro    │  goldmanplumbing  │
│   ↓ STDIO subprocess             │  API key   │  services         │
│  Simpro tool (node)              │ ─────────▶ │  .simprosuite.com │
│  installed at                    │            │                   │
│  %LOCALAPPDATA%\GoldmanSimproMCP │            └───────────────────┘
└──────────────────────────────────┘
```

Everything runs locally on your PC. Claude Desktop launches the Simpro tool
as a small background process. The tool talks to Simpro using your own
Simpro API key.

---

## Part 0 — The fast way: run the installer (recommended)

**Pre-requisite:** Node.js 18.17+ installed (see Part 2 if you don't have it).

1. **Get your Simpro API key first** — see Part 1 below for how to create one.
2. **Open the SharePoint folder** in File Explorer:
   ```
   C:\Users\<YOU>\GoldmanPlumbing\Goldman Plumbing Services\Energy - Documents\IT\SimProMCP
   ```
   (replace `<YOU>` with your Windows username, e.g. `jsmith`)

   If the folder doesn't exist, you don't have OneDrive synced — open
   Microsoft Teams or your browser, find **Energy → IT → SimProMCP**,
   click **Sync**.
3. **Double-click `install.cmd`**. (If Windows shows a "Windows protected your
   PC" warning, click *More info* → *Run anyway*.)
4. **Follow the prompts:** paste your API key, choose 1/2/3 (Plumbing /
   Energy / both — pick 3 if unsure), wait ~30 seconds.
5. **Quit Claude Desktop** from the system tray (right-click tray icon →
   Quit, near the clock — bottom right). Wait 3 seconds, reopen.
6. **Test it:** type *"Use Simpro Plumbing to test the connection."* in
   Claude Desktop. You should see *"Simpro connection OK…"*.

**Done.** You can skip Parts 3 and 4 below. Read Part 1 (how to create your
API key) and Part 6 (turning on writes later).

When IT releases an update, just open the SharePoint folder again and
double-click **`update.cmd`** instead.

If the installer doesn't work for any reason, the manual steps in Parts 3–4
give you the same result.

---

## Part 1 — Create your own Simpro API key

> ⚠️ **Don't share keys.** Each person uses their own. If yours is leaked or
> you leave the company, just delete it in Simpro.

### Step 1.1 — Log into Simpro

Open <https://goldmanplumbingservices.simprosuite.com> and log in as usual.

### Step 1.2 — Open the API Keys page

In Simpro:

1. Click the **gear / cog icon** at the top right (the **System** menu).
2. Click **Setup** → **System** → **Setup** → **API Keys**.
   *(Exact wording can vary by Simpro version. If you can't find it, search
   the Simpro help with "API key" or ask a Simpro admin to point you there.)*

You will land on a page titled something like **"API Keys"** showing existing
keys (probably empty for you).

### Step 1.3 — Add a new API key

1. Click **+ Add** (or **+ Create API Key**).
2. **Name it after yourself**, e.g. `Jane Smith - Claude Desktop`.
   This makes it easy to revoke later.
3. **Linked Employee:** select **your own employee record** in Simpro. The
   API key will act *as you* — so anything Claude does will appear under your
   name in Simpro's audit logs. Don't link it to a generic shared user.
4. **Permissions:** start with **Read-only** (View) for testing. After a few
   days you can come back and add Edit/Create permissions for the areas you
   need (Customers, Jobs, Quotes, Sites, Tasks, Notes).
5. Click **Save**.

### Step 1.4 — Copy the access token IMMEDIATELY

Simpro will show the **Access Token** (a long string like
`a1b2c3d4e5f6...` — much longer, 40+ characters).

> 🚨 **Copy it right now into a private note** (e.g. a personal OneNote /
> private password manager). Simpro typically shows it **only once** — if you
> close the page without copying, you'll have to delete the key and create a
> new one.

**Do NOT share this token with anyone, do NOT email it, and do NOT paste it
into team chats.** Treat it like your password.

### Step 1.5 — Find your Company ID (one-time)

If you ONLY work in *Goldman Plumbing Services Pty Ltd*, your Company ID is
**`4`**. If you also work in *Goldman Energy* you'd use **`37`** for that.
If unsure, ask whoever set up your access — or skip ahead and the test in
Part 5 will tell you if it's wrong.

---

## Part 2 — Install Node.js

This is the engine that runs the Simpro tool. One-time install.

1. Go to <https://nodejs.org>.
2. Download the **LTS** version (the big green button on the left). It will
   be a `.msi` installer.
3. Run the installer. Click **Next, Next, Next, Install**. Defaults are fine.
4. When done, open the **Start menu**, type `PowerShell`, and press Enter.
5. In the black PowerShell window, type:
   ```
   node --version
   ```
   Press Enter. It should print something like `v20.11.0`. If yes, you're done
   with Part 2. Close PowerShell.

If it says *"node is not recognized"*, restart your PC and try again.

---

## Part 3 — Get the Simpro tool onto your PC

You only do this once.

### Option A — IT puts the tool in a shared folder (recommended for non-coders)

Ask IT to copy the entire `simpro-mcp-server` folder into your PC at a known
location, for example:
```
C:\Tools\simpro-mcp-server\
```
The folder must contain a `dist` subfolder with `index.js` inside it.

If `dist\index.js` already exists, **skip to Part 4**.

### Option B — Build it yourself

1. Copy the project folder to `C:\Tools\simpro-mcp-server\` (or anywhere you
   like).
2. Open PowerShell.
3. Run these three commands one at a time:
   ```powershell
   cd C:\Tools\simpro-mcp-server
   npm install
   npm run build
   ```
4. The last command should finish without red errors. You should now have a
   `dist\index.js` file inside the folder.

---

## Part 4 — Connect to Claude Desktop

### Step 4.1 — Find the Claude config file

1. Press **Windows key + R** to open the **Run** dialog.
2. Type:
   ```
   %APPDATA%\Claude
   ```
   …and press Enter. File Explorer opens that folder.
3. Look for a file called **`claude_desktop_config.json`**.
   - If it **already exists**, right-click → *Open with* → *Notepad*.
   - If it **doesn't exist**, right-click empty space → *New* → *Text Document*.
     Rename it to **exactly** `claude_desktop_config.json` (delete the
     `.txt` extension — Windows may warn you, click *Yes*).

### Step 4.2 — Paste in your config

The Goldman Simpro tenant has **two companies**: Goldman Plumbing Services
(ID `4`) and Goldman Energy (ID `37`). The block below sets up **both** as
separate tools so you can switch by saying *"Use Simpro Plumbing…"* or
*"Use Simpro Energy…"* without restarting anything.

If you only ever work in one of them, you can delete the other block.

**Two things to change** before saving:

1. Replace the `args` path with **your real path** to `dist\index.js`.
   Use **double backslashes** (`\\`) — this is required for JSON.
   (Use the same path in both blocks — they share the same code.)
2. Replace `PASTE_YOUR_API_KEY_HERE` with the API key you saved in Step 1.4
   (use the same key in both blocks — one Simpro key works for both companies).

```json
{
  "mcpServers": {
    "simpro_plumbing": {
      "command": "node",
      "args": [
        "C:\\Tools\\simpro-mcp-server\\dist\\index.js"
      ],
      "env": {
        "SIMPRO_BASE_URL": "https://goldmanplumbingservices.simprosuite.com",
        "SIMPRO_API_KEY": "PASTE_YOUR_API_KEY_HERE",
        "SIMPRO_COMPANY_ID": "4",
        "SIMPRO_ENABLE_WRITE_TOOLS": "false",
        "SIMPRO_DRY_RUN": "true"
      }
    },
    "simpro_energy": {
      "command": "node",
      "args": [
        "C:\\Tools\\simpro-mcp-server\\dist\\index.js"
      ],
      "env": {
        "SIMPRO_BASE_URL": "https://goldmanplumbingservices.simprosuite.com",
        "SIMPRO_API_KEY": "PASTE_YOUR_API_KEY_HERE",
        "SIMPRO_COMPANY_ID": "37",
        "SIMPRO_ENABLE_WRITE_TOOLS": "false",
        "SIMPRO_DRY_RUN": "true"
      }
    }
  }
}
```

> If you already have other MCP tools in this file (e.g. for Google Drive),
> just add the two `simpro_*` entries **inside** the existing `"mcpServers"`
> block, separated by commas. Don't add a second `"mcpServers"` block.

**Save the file.**

### Step 4.3 — Restart Claude Desktop properly

1. Look at the system tray (bottom-right of your taskbar, near the clock).
2. Find the **Claude icon**. Right-click it → **Quit**.
3. Wait 3 seconds.
4. Open Claude Desktop again from the Start menu.

> Just closing the Claude window is **not enough** — you must use **Quit**
> from the tray icon.

---

## Part 5 — Test it works

In Claude Desktop, look near the message box for a small **tools / hammer icon**.
Click it. You should see **two entries** — `simpro_plumbing` and
`simpro_energy` — each with ~57 tools.

Type into the chat:

> **Use Simpro Plumbing to test the connection.**

Claude will run the connection test. Expected result:
> ✅ *"Simpro connection OK. Base URL: …, Company ID: 4, …"*

Then try the other one:

> **Use Simpro Energy to test the connection.**

Should give you `Company ID: 37`. If both work — **everything works**. 🎉

### Things to try next

| Try saying… | What it does |
|---|---|
| *"Use Simpro to search for customers named Goldman."* | Lists matching customer records |
| *"Use Simpro to find recent jobs."* | Shows the latest jobs |
| *"Use Simpro to get job 130747."* | Returns the full record for that job |
| *"Use Simpro to list our job statuses."* | Shows the status IDs you can use |
| *"Use Simpro to list our cost centres."* | Useful when creating jobs |

While `SIMPRO_ENABLE_WRITE_TOOLS=false` (the default), Claude can **only read**.
Nothing in Simpro will be changed.

---

## Part 6 — Turning on write tools (later, when you're ready)

After a few days of comfortable read-only use, you can let Claude create or
update Simpro records. **Do this in two stages.**

### Stage 1 — Dry run (safe preview)

1. Open `claude_desktop_config.json` again.
2. Change `"SIMPRO_ENABLE_WRITE_TOOLS"` from `"false"` to `"true"`.
3. Leave `"SIMPRO_DRY_RUN"` as `"true"`.
4. Save → Quit Claude from the tray → reopen Claude.

Now if you ask Claude to update something:

> *"Use Simpro to update customer 14930 with a new phone number 02 9999 0000. Confirm true."*

Claude will reply with a **DRY RUN preview** showing exactly which API call
*would* be sent — but **nothing actually changes in Simpro**. Read the
preview carefully. If it looks correct, you're ready for stage 2.

> 🛡 **Safety: every write also requires `confirm: true`.** If you forget,
> Claude returns a confirmation request instead of doing anything.

### Stage 2 — Real writes

1. Open the config file.
2. Change `"SIMPRO_DRY_RUN"` from `"true"` to `"false"`.
3. Save → Quit Claude → reopen.

From now on, write commands actually go to Simpro. Start with **small,
low-risk changes** (e.g. adding a note to a test job) before doing anything
bulk.

> If anything ever feels wrong, **set `"SIMPRO_ENABLE_WRITE_TOOLS"` back to
> `"false"`** and restart Claude. That immediately stops all writes.

---

## Common problems and fixes

| Problem | Fix |
|---|---|
| Claude doesn't show **simpro** under tools | You probably didn't fully Quit Claude. Right-click tray icon → Quit, then reopen. |
| *"401 Unauthorized" / "API key invalid"* | Your API key is wrong, expired, or was deleted in Simpro. Generate a new one (Part 1) and update the config. |
| *"403 Forbidden"* | The API key works, but doesn't have permission for that area. In Simpro, edit the API key's linked employee and grant the missing permission. |
| *"404 Not Found"* | Wrong `SIMPRO_COMPANY_ID`. Goldman Plumbing Services = **4**, Goldman Energy = **37**. |
| *"Write tools are disabled"* | This is the safety guard. Change `"SIMPRO_ENABLE_WRITE_TOOLS"` to `"true"` and restart Claude. |
| *"Confirmation required"* | Add `confirm: true` to your request, or tell Claude *"…and confirm true"*. |
| The config file gets a red error icon | JSON syntax error — usually a missing comma, smart quotes, or single backslashes in paths. Open in VS Code (free, from <https://code.visualstudio.com>) — it will highlight the problem. |
| *"Could not reach Simpro"* | Check you can open <https://goldmanplumbingservices.simprosuite.com> in your browser. If your office uses a VPN, connect to it. |

---

## Rotating or revoking your API key

**Do this if:**
- You think your key may have leaked (e.g. accidentally pasted in a chat).
- You're leaving Goldman Plumbing.
- It's been more than ~6 months and you want fresh credentials.

**How:**
1. Log into Simpro → API Keys page (Part 1, Step 1.2).
2. Click **+ Add** to create a fresh key (give it a different name like
   `Jane Smith - Claude Desktop v2`).
3. Copy the new access token.
4. Open `claude_desktop_config.json`, paste the new token in
   `SIMPRO_API_KEY`, save.
5. Quit & reopen Claude Desktop.
6. Confirm with *"Use Simpro to test the connection."*
7. Once the new key works, **go back to Simpro and DELETE the old key**.

---

## Asking IT for help

If something on this guide doesn't work for you, send the IT person:

1. **Which step number** you got stuck on.
2. **The exact error message** Claude or Simpro showed (a screenshot is fine,
   but **never include your API key** in the screenshot — blur it out).
3. **Your Windows version** (right-click *This PC* → *Properties*).

Good luck!
