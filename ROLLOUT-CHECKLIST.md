# Rolling out the Simpro MCP to Goldman staff

This is for **you** (the person rolling it out — Tayfun / Sinan / IT).
For coworkers, send them [SETUP-GUIDE.md](SETUP-GUIDE.md) instead.

---

## One-time prep — make a shareable package (≈10 min)

The goal: a single folder coworkers can copy to their PC and run, with no
build step required.

### 1. Build a clean release

In PowerShell from this project folder:

```powershell
npm install
npm run build
```

This creates the `dist/` folder containing the compiled JS.

### 2. Stage the share folder

Create a clean folder somewhere shareable, e.g.
`OneDrive - Goldman Plumbing Services\IT\simpro-mcp-server-release\`.

Copy **only these items** into it:

```
simpro-mcp-server-release/
  install.cmd            ← double-clickable installer (REQUIRED for the easy path)
  install.ps1            ← installer logic (called by install.cmd)
  update.cmd             ← double-clickable updater for future releases
  update.ps1             ← updater logic
  dist/                  ← compiled tool
  node_modules/          ← bundled dependencies (saves coworkers the npm install step)
  package.json
  package-lock.json
  SETUP-GUIDE.md
  README.md
```

**Do NOT copy:** `src/`, `tsconfig.json`, `.env`, `.env.example`, `.git/`,
`.gitignore`, `ROLLOUT-CHECKLIST.md` (this file). Coworkers don't need any
of that — the only thing Claude Desktop runs is `dist/index.js`.

> **Why include `node_modules`?** It contains the MCP SDK + dependencies
> already downloaded. If you skip it, every coworker has to install Node.js,
> open PowerShell, and run `npm install` themselves. Bundling it removes
> that step. The folder is ~50–100 MB but you only sync it once.

### 3. Test the package on a fresh path

To make sure nothing in `dist/` references your dev path:

```powershell
node "OneDrive - Goldman Plumbing Services\IT\simpro-mcp-server-release\dist\index.js"
```

(With env vars temporarily set as needed — see SETUP-GUIDE Step 4.2.)
You should see `[info] simpro-mcp-server started…` on stderr. Press
**Ctrl+C** to stop. If it works here, it'll work on coworkers' PCs.

### 4. Share the folder

Two options, in order of preference:

| Option | How | Pros | Cons |
|---|---|---|---|
| **OneDrive shared link** | Right-click folder → *Share* → grant view+download to specific people | They always get the latest version when you update it | Requires they sync it to a known local path |
| **Zip + email** | Right-click → *Send to → Compressed folder* | Simple, no permissions needed | Coworkers stuck on whatever version they got |

If you use OneDrive, recommend they sync it to **`C:\Tools\simpro-mcp-server\`**
on their PC (so the `args` path in their config is consistent with the guide).

---

## Per-coworker checklist (with installer — recommended)

Send this email to each coworker along with the link to the share folder:

> Hi [name],
>
> We've built a tool that lets you read and update Simpro data by chatting
> with Claude on your PC. Setup is just a few clicks.
>
> **Step 1 — Get your own Simpro API key.** (See Part 1 of the attached
> SETUP-GUIDE.md for screenshots.) Generate it in Simpro under
> *System ▸ Setup ▸ System ▸ API Keys*, name it after yourself, link it to
> your own employee record, and **copy the access token** when Simpro shows
> it (Simpro shows it only once).
>
> **Step 2 — Make sure Node.js is installed.** If you don't have it:
> <https://nodejs.org> → click the green LTS button → run installer →
> defaults → restart your PC.
>
> **Step 3 — Open this folder:** [link to your OneDrive share folder].
>
> **Step 4 — Double-click `install.cmd`.** Paste your API key when asked,
> press 3 (both companies), wait 30 seconds.
>
> **Step 5 — Quit Claude Desktop fully** (right-click the Claude icon in
> the system tray near the clock → Quit). Wait 3 seconds, reopen.
>
> **Step 6 — Test it:** in Claude Desktop, type
> *"Use Simpro Plumbing to test the connection."*
> You should see "Simpro connection OK".
>
> Writes are **off by default** for the first week — Claude can only
> read your Simpro data, never modify it. We'll turn writes on later when
> you're comfortable.
>
> Anything weird, send me a screenshot.

If the installer doesn't work on a particular PC (rare — usually a Windows
SmartScreen block), the manual steps in SETUP-GUIDE.md Parts 2–4 produce
the same result.

---

## Updating after release

When you release a new version (e.g. add tools):

1. `npm run build` from your dev folder.
2. Copy the **new** `dist/` over the one in the release folder.
3. If dependencies changed (`package.json`), copy the new `node_modules/`
   too. If only code changed, `dist/` alone is enough.
4. Tell coworkers to:
   - **Double-click `update.cmd`** in the share folder. It refreshes their
     local copy without touching their API key or Claude config.
   - **Then quit Claude Desktop from the tray and reopen** to pick up the
     new tools.

If they used the installer originally, this is the only thing they need
to do for updates — no config edits, no key re-entry.

OneDrive will sync the changes automatically if you used the OneDrive
share option.

---

## Per-coworker security checklist

Each coworker:

- ✅ has their **own** Simpro API key (named after them in Simpro)
- ❌ never shares their key with anyone
- ❌ never pastes the key in screenshots, chats, or emails
- ✅ knows they can rotate the key any time (SETUP-GUIDE → "Rotating")
- ✅ starts with `SIMPRO_ENABLE_WRITE_TOOLS=false` for their first week

When someone leaves Goldman:

1. Log into Simpro → API Keys page → delete that person's key.
2. They keep their copy of `dist/`, but with no key it's useless — every
   request returns 401.

---

## What to do if something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Coworker says "tool not in Claude" | Didn't fully Quit Claude | Tray icon → Quit, reopen |
| Coworker says "401 Unauthorized" | Bad / deleted API key | Have them generate a new one |
| Coworker says "404 Not Found" on every request | Wrong company ID | They're using `simpro_plumbing` for an Energy record (or vice versa) |
| Coworker says "JSON syntax error" on Claude startup | Bad edit to config | Open file in VS Code → fix the highlighted issue (usually a comma or a single backslash) |
| All coworkers suddenly get 401 | Tenant-wide API outage, or maintenance | Check Simpro status, retry |

For anything else, capture: the exact error message, which tool was being
called, the company they used (plumbing vs energy). Send that to the
maintainer (currently Tayfun / Sinan).
