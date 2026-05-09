# Deploy the Simpro MCP server on Ubuntu (with Tailscale)

This is for Tayfun (admin) to deploy the server on the office Ubuntu machine
the first time. Total time: ~30 minutes. **No Linux knowledge required** —
every command is spelled out and you'll see the expected output.

If anything goes wrong, **stop and ask Claude** rather than guessing.

---

## Before you start

Make sure these are true:

- ✅ Ubuntu server is on and you can RDP into it (you've already done this).
- ✅ Tailscale is installed and connected on the server (already verified —
  the server has Tailscale IP `100.121.87.69` and hostname `goldman-ubuntu`).
- ✅ MagicDNS is enabled on the tailnet (already done — the URL
  `http://goldman-ubuntu:3001/...` will work).
- ✅ The Ubuntu user `goldman` has sudo privileges (it does — we saw
  `27(sudo)` in the groups list).

If any of those isn't true, fix it first.

---

## Architecture (one diagram)

```
   ┌─────────────────────────┐    Tailscale (encrypted)   ┌──────────────────┐
   │ Coworker PC (anywhere)  │ ─────────────────────────▶ │ Ubuntu server    │
   │ Tailscale running       │   100.121.87.69 :3001       │ (this machine)   │
   │ Claude Desktop with     │                             │  /opt/simpro-mcp │
   │ Custom Connector        │                             │  systemd service │
   │ + smcp_* bearer token   │                             │  bound to TS IP  │
   └─────────────────────────┘                             └────────┬─────────┘
                                                                    │ HTTPS
                                                                    │ uses each
                                                                    │ user's own
                                                                    │ Simpro key
                                                                    ▼
                                                          ┌──────────────────┐
                                                          │ Simpro Cloud     │
                                                          │ (audit shows the │
                                                          │  real employee)  │
                                                          └──────────────────┘
```

The server **only listens on the Tailscale IP**. If a device isn't on your
tailnet, it cannot reach the server at all — even if it's on the office
LAN. Bearer tokens then gate per-user access on top of that.

---

## Part 1 — Run the installer (5 minutes)

### Step 1.1 — Open the Terminal on the Ubuntu server

You should already be RDP'd into the server. Open **Terminal**:

- Keyboard: `Ctrl + Alt + T`
- Or: click the apps menu → search "Terminal" → click it

You'll see a black window with a prompt like `goldman@Goldman-Ubuntu:~$`.

### Step 1.2 — Paste this single command and press Enter

```bash
curl -fsSL https://raw.githubusercontent.com/haylazF16/SimProMCP/feat/http-transport/scripts/install-on-ubuntu.sh | sudo bash
```

**What this does**: downloads the install script directly from GitHub and
runs it as root. The script:

1. Verifies it's running on Ubuntu and that Tailscale is connected.
2. Installs Node.js 20 LTS (if not already there).
3. Installs `git`, `ufw` (firewall), `curl`, `jq` (small JSON tool).
4. Creates a system user called `simpro-mcp` (unprivileged — runs the service safely).
5. Clones the project into `/opt/simpro-mcp`.
6. Runs `npm ci` and `npm run build` to build the TypeScript.
7. Creates `/opt/simpro-mcp/.env` with safety flags **off by default** (writes
   disabled, dry-run on — same conservative defaults as before).
8. Creates the systemd service `simpro-mcp` that auto-starts at boot.
9. Configures the firewall to allow port 3001 only from Tailscale.
10. Smoke-tests the health endpoint.

You'll see colored output as it goes. **Total time: ~3 minutes.**

You may be asked for your `goldman` user's password (because it uses `sudo`).
Type the password (you won't see characters appear — that's normal) and
press Enter.

### Step 1.3 — Look for the success line

When the script finishes, the last lines should be:

```
==============================================================
  Simpro MCP server installed and running on Ubuntu.
==============================================================
```

If you see that, Part 1 is done. ✅

If you see a red error message, **stop and paste the entire output back to
Claude Code** — don't try to fix it yourself.

---

## Part 2 — Verify the server is running (1 minute)

### Step 2.1 — Check service status

In the same Terminal, run:

```bash
sudo systemctl status simpro-mcp
```

Expected output (look for `active (running)` in green):

```
● simpro-mcp.service - Simpro MCP Server (HTTP transport, Tailscale-bound)
     Loaded: loaded (/etc/systemd/system/simpro-mcp.service; enabled; ...)
     Active: active (running) since ...
```

Press `q` to exit.

### Step 2.2 — Hit the health endpoint

```bash
curl http://goldman-ubuntu:3001/healthz
```

Expected output (one line, JSON):

```json
{"ok":true,"service":"simpro-mcp-server","transport":"http",...}
```

If both work, the server is fully alive. ✅

---

## Part 3 — Add yourself as the first user (3 minutes)

### Step 3.1 — Run the user-registration script

```bash
sudo bash /opt/simpro-mcp/scripts/add-user.sh
```

It asks four questions:

1. **Person's name**: type `Tayfun Yildirim` (or however you'd like to be
   labelled in audit logs).
2. **Their Simpro API key**: paste your Simpro access token (the
   40-character hex string you saved when you created your API key in
   Simpro). The script records this in `tokens.json` for the server to
   use on your behalf.
3. **Which company**: type `3` for both Plumbing and Energy.
4. **Allow writes**: type `n` for now (we'll enable later after testing).

### Step 3.2 — Copy the bearer token it prints

You'll see something like:

```
==== User added ====
  Name:         Tayfun Yildirim
  Companies:    plumbing, energy
  Write tools:  false

  Bearer token (give to user, then DO NOT keep this on screen):
  smcp_AbcDefGhi1234567...

Send the user this connection info ...
  URL:     http://goldman-ubuntu:3001/mcp/plumbing
  Bearer:  smcp_AbcDefGhi1234567...
  ...
```

**Copy that `smcp_...` token now** to a private note (Tailscale-encrypted
sticky note, password manager, etc.). You'll paste it into Claude Desktop
in the next step.

### Step 3.3 — Clear the screen so the token doesn't linger

```bash
clear
```

---

## Part 4 — Connect Claude Desktop on YOUR PC (5 minutes)

Switch back to your Windows PC (close the RDP window or just minimise it).

### Step 4.1 — Make sure Tailscale is running on your PC

Look at the Windows system tray (bottom-right, near the clock). You should
see the Tailscale icon. Right-click it → it should say "Connected" with your
Tailscale IP. (We saw earlier you have `100.90.29.28`.)

If not connected, click **Sign in** in the menu. This is one-time.

### Step 4.2 — Open Claude Desktop → Settings → Connectors

1. Click your profile circle (bottom-left in Claude Desktop) → **Settings**.
2. Click **Connectors** in the sidebar.
3. Scroll down → click **Add custom connector**.

### Step 4.3 — Add the Plumbing connector

| Field | Value |
|---|---|
| Name | `Goldman Plumbing` |
| Remote MCP server URL | `http://goldman-ubuntu:3001/mcp/plumbing` |
| Authentication | **Bearer token** |
| Token | the `smcp_...` token from Step 3.2 |

Click **Add**.

### Step 4.4 — Add the Energy connector

Repeat with:

| Field | Value |
|---|---|
| Name | `Goldman Energy` |
| URL | `http://goldman-ubuntu:3001/mcp/energy` |
| Token | **same** `smcp_...` token (one token, both companies) |

### Step 4.5 — Quit and reopen Claude Desktop

System tray (Windows) → right-click Claude icon → **Quit**. Wait 5 seconds.
Reopen.

### Step 4.6 — Test

In Claude Desktop chat, type:

> *"Use Simpro Plumbing to test the connection."*

Expected:

```
Simpro connection OK.
Base URL: https://goldmanplumbingservices.simprosuite.com
Company ID: 4
Write tools enabled: false
Dry run: true
```

Then:

> *"Use Simpro Energy to test the connection."*

Should report **Company ID: 37**.

If both work, you're successfully running off the Ubuntu server. 🎉

---

## Part 5 — Onboard a coworker (~5 minutes per person)

For each coworker who needs access:

### Step 5.1 — Get them on Tailscale

If they're not already on the tailnet:

1. Send them the install link: <https://tailscale.com/download/windows>
2. They run the installer.
3. They click **Sign in** → sign in with the Goldman Tailscale account
   (username `barboros3444@`).

You can also use Tailscale's "share" feature if you'd rather not have them
log in to your account — see <https://login.tailscale.com/admin/users>.

### Step 5.2 — They get their own Simpro API key

They follow the existing `COWORKER-CONNECT.md` Part 1 (already in this repo)
to create their own Simpro key under their Simpro employee record.

They send you the key via direct message (NOT a group chat).

### Step 5.3 — You register them

Back on Ubuntu Terminal:

```bash
sudo bash /opt/simpro-mcp/scripts/add-user.sh
```

Fill in their name, paste their Simpro key, choose company access, set
write access (start with N).

The script prints a fresh `smcp_...` token. Send the token to that coworker
(direct message only).

### Step 5.4 — They configure Claude Desktop

Send them the updated `COWORKER-CONNECT.md` (the Tailscale version). They
follow it: install Tailscale, paste URL + token, restart Claude Desktop, test.

---

## Day-to-day operations

### Check who's registered

```bash
sudo bash /opt/simpro-mcp/scripts/list-users.sh
```

(Tokens are masked, Simpro keys are NEVER shown.)

### Revoke a coworker

```bash
sudo bash /opt/simpro-mcp/scripts/revoke-user.sh
```

It walks you through finding the user by name and confirming.

### See live server logs

```bash
sudo journalctl -u simpro-mcp -f
```

(Press `Ctrl+C` to stop tailing.)

### See the audit log (every tool call)

```bash
sudo tail -f /opt/simpro-mcp/audit.log
```

One line per tool call: `{ts, user, company, tool, ok, durationMs}`.

### Restart the server (e.g. after editing .env)

```bash
sudo systemctl restart simpro-mcp
```

### Pull a code update from GitHub

```bash
cd /opt/simpro-mcp
sudo -u simpro-mcp git pull
sudo -u simpro-mcp npm ci
sudo -u simpro-mcp npm run build
sudo systemctl restart simpro-mcp
```

(One-liner for that whole block, optional shortcut you can save:)

```bash
cd /opt/simpro-mcp && sudo -u simpro-mcp bash -c 'git pull && npm ci && npm run build' && sudo systemctl restart simpro-mcp
```

### Enable real writes (when you're ready)

Edit `/opt/simpro-mcp/.env`:

```bash
sudo nano /opt/simpro-mcp/.env
```

Find these two lines and change them:

```
SIMPRO_ENABLE_WRITE_TOOLS=true
SIMPRO_DRY_RUN=false
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

Restart:

```bash
sudo systemctl restart simpro-mcp
```

You can also leave `SIMPRO_DRY_RUN=true` for an extra layer — every write
shows you what it WOULD do but doesn't actually send. Flip to `false` only
when you're confident.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl: (7) Failed to connect to goldman-ubuntu` | Is Tailscale running on your PC? Try `tailscale ping goldman-ubuntu` from your Windows command line. |
| Service won't start | `sudo journalctl -u simpro-mcp -n 50 --no-pager` shows recent logs. Send to Claude. |
| `Address already in use` for port 3001 | Something else (Vikunja?) is on that port. Pick a different port: edit `/opt/simpro-mcp/.env`, change `SIMPRO_HTTP_PORT=3001` to e.g. `3002`, then `sudo systemctl restart simpro-mcp`. Update coworker URLs accordingly. |
| Coworker says "401 Unauthorized" | Their bearer token is wrong/revoked. Run `list-users.sh` to confirm they exist; if not, run `add-user.sh` again with a fresh token. |
| Coworker says "403 Forbidden" | Their token doesn't have access to that company. Re-run `add-user.sh` with the right company access. |
| Claude Desktop doesn't show the new connectors | Coworker didn't fully Quit (system tray → Quit, not just close window). |

---

## Migration plan from the old Windows-PC server

Don't rush this. Recommended order:

1. **Today**: install on Ubuntu, register yourself, test. **Keep the Windows
   PC server running** in parallel. Don't change coworker configs yet.
2. **This week**: ask one coworker to switch their Claude Desktop config to
   the Ubuntu URL. They use it for a few days. If anything goes wrong, they
   switch back to the Windows config — zero downtime, zero risk.
3. **Next week**: roll out the Ubuntu URL to everyone. Decommission the
   Windows-PC server after a few days of confirmed stability:
   - Tray icon → Quit Claude Desktop
   - Stop the service: `Get-Service GoldmanSimproMCP | Stop-Service`
   - Uninstall: `sudo bash scripts\uninstall-service.ps1` (in elevated PowerShell)

You can run both in parallel for as long as you like — they don't conflict
(different machines, different IPs).

---

## When something needs Claude's help

Send Claude (here in Claude Code, not Claude Desktop):

1. Which step you're on.
2. The exact command you ran.
3. The exact output you got (paste the full thing — don't summarise).

Don't include any `smcp_*` tokens or Simpro API keys in what you paste.
Mask them as `smcp_***` if they appear.
