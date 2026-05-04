# Server-side setup (admin guide)

You — IT — install the Simpro MCP server as a Windows service on **one PC**
(your PC for now, an old PC later). Coworkers connect to it from their PCs
via Claude Desktop's Custom Connector.

This document is for **you**. For coworkers, send them
**[COWORKER-CONNECT.md](COWORKER-CONNECT.md)**.

---

## What you're setting up

```
Your server PC:                      Each coworker's PC:
┌────────────────────────────┐
│ Windows service:           │      ┌─────────────────┐
│   GoldmanSimproMCP         │      │ Claude Desktop  │
│                            │◄─────┤ Custom Connector│
│ HTTP on 0.0.0.0:3001       │      │ + bearer token  │
│   /mcp/plumbing            │      └─────────────────┘
│   /mcp/energy              │      ┌─────────────────┐
│                            │◄─────┤ Coworker B      │
│ tokens.json (per-user keys)│      └─────────────────┘
│ audit.log (every call)     │
└────────────────────────────┘
            │
            │ HTTPS to Simpro using each coworker's OWN Simpro API key
            ▼
     Simpro tenant (audit log shows real employee names)
```

Why this is good:
- **One process to update.** Coworker PCs don't need Node.js, don't need the
  code, don't need an installer. Update = `git pull` + restart service.
- **Real audit trail in Simpro.** Each user's bearer token is mapped to that
  user's own Simpro API key, so Simpro records the actual employee for every
  call.
- **Per-user controls.** Disable a coworker's writes without affecting others.
  Revoke a token instantly without touching Simpro.

---

## Part 1 — One-time install (≈10 minutes)

### Prerequisites

On the server PC:

- Windows 10 or 11.
- **Node.js LTS** (v18.17+). Install from <https://nodejs.org>, defaults are fine.
- **Git** (to clone the repo). Or you can copy the project folder by hand.
- **Local administrator rights** (the install script needs them to register
  the Windows service).

### Step 1 — Clone the repo

Open **PowerShell** and:

```powershell
cd C:\Tools           # or wherever you keep tools; create the folder if needed
git clone https://github.com/haylazF16/SimProMCP.git simpro-mcp-server
cd simpro-mcp-server
npm install
npm run build
```

You should now have a `dist\` folder containing `index.js`. Verify with:

```powershell
node dist\index.js
```

It will print an error about missing `SIMPRO_API_KEY` — that's expected
because we haven't configured it yet. Press **Ctrl+C** to stop.

### Step 2 — Install as a Windows service

**Open a new PowerShell window as Administrator** (right-click PowerShell
icon → *Run as administrator*), then:

```powershell
cd C:\Tools\simpro-mcp-server
.\scripts\install-as-service.ps1
```

The script will ask you a few questions (defaults shown in `[brackets]` —
just press Enter to accept):

| Prompt | Default | When to change |
|---|---|---|
| Simpro base URL | `https://goldmanplumbingservices.simprosuite.com` | Never (this is correct for Goldman) |
| Default company ID | `4` | Never (legacy fallback only — actual company is per-route) |
| Bind address | `0.0.0.0` | Use `127.0.0.1` if you only want localhost access during testing |
| Port | `3001` | Change only if 3001 is already in use |

The script will:
1. Set system environment variables for the service.
2. Install `node-windows` locally.
3. Add a Windows Firewall rule allowing TCP 3001 inbound on Private/Domain networks (NOT Public).
4. Register `GoldmanSimproMCP` as a Windows service that auto-starts at boot.
5. Start the service.

You'll see something like:

```
Service is installed and starting.
Health: http://localhost:3001/healthz
```

### Step 3 — Verify the service is running

```powershell
Invoke-WebRequest http://localhost:3001/healthz | Select-Object -ExpandProperty Content
```

Expected output:
```json
{"ok":true,"service":"simpro-mcp-server","transport":"http","version":"0.1.0",...}
```

If you get this, the server is alive. ✅

### Step 4 — Find the server's LAN IP (give to coworkers)

```powershell
Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual | Where-Object {$_.InterfaceAlias -notlike "*Loopback*"} | Select-Object IPAddress,InterfaceAlias
```

Note the IP address (e.g. `192.168.1.50`). Coworkers will use:
- `http://192.168.1.50:3001/mcp/plumbing`
- `http://192.168.1.50:3001/mcp/energy`

> **Tip:** if your office router supports it, give this PC a **DHCP
> reservation** (static IP) so the address doesn't change when the PC
> reboots. Or give it a hostname coworkers can use like
> `http://goldman-server.local:3001/mcp/plumbing`.

---

## Part 2 — Add a coworker

Each time a new coworker needs access:

1. **They generate their own Simpro API key** in Simpro (they follow Part 1
   of [COWORKER-CONNECT.md](COWORKER-CONNECT.md)).
2. **They send you the API key** by a secure channel — internal direct
   message is fine; do not put it in a chat with many people.
3. **You run** (in a regular PowerShell window in the project folder):

   ```powershell
   .\scripts\add-user.ps1
   ```

   It will ask:
   - Their name (used in audit log)
   - Their Simpro API key (paste it)
   - Which company (1=Plumbing, 2=Energy, 3=Both — usually 3)
   - Allow writes? (y/N — say N for the first week)

4. **The script prints a bearer token**, e.g.
   `smcp_8aZ-pK_R9...`. **Send this token to the coworker** along with the
   two URLs:
   - Plumbing URL: `http://<server-ip>:3001/mcp/plumbing`
   - Energy URL:   `http://<server-ip>:3001/mcp/energy`

5. They follow Parts 2-3 of [COWORKER-CONNECT.md](COWORKER-CONNECT.md) and
   are ready to use the tool.

> **Privacy:** the token is a credential. Treat it like a password.
> Don't email a list of tokens; send each coworker theirs individually.

---

## Part 3 — Day-to-day operations

### List who has access

```powershell
.\scripts\list-users.ps1
```

Shows name, companies, write status, last-used timestamp. Tokens are
shown masked. Simpro API keys are never shown.

### Revoke a coworker's access

```powershell
.\scripts\revoke-user.ps1
```

Requires you to type the user's name to confirm. Removes their token from
`tokens.json`. **Also remember to delete their API key in Simpro** for
full revocation.

### Enable writes for a user

Currently the `add-user.ps1` script is the way to do this. Re-run it for
the same user, paste the same Simpro key, choose Y for writes — it adds a
NEW token. Then revoke their old token. (A `set-user-writes.ps1` script
could be added later if this becomes common.)

### See the audit log

```powershell
Get-Content audit.log -Wait -Tail 10
```

One JSON object per line. Format:
```json
{"ts":"2026-05-04T...","user":"Tayfun","company":"plumbing","tool":"simpro_search_jobs","ok":true,"durationMs":234}
```

To find a specific user's activity:
```powershell
Select-String -Path audit.log -Pattern '"user":"Tayfun"'
```

### Check service status

```powershell
Get-Service GoldmanSimproMCP
```

### View server logs

Event Viewer → Windows Logs → Application → filter source `GoldmanSimproMCP`.

### Restart the service

```powershell
Restart-Service GoldmanSimproMCP
```

Coworkers don't need to do anything when you restart — Claude Desktop
re-establishes the connection on the next request.

---

## Part 4 — Updating the server

When new tools or fixes land:

```powershell
cd C:\Tools\simpro-mcp-server
git pull
npm install
npm run build
Restart-Service GoldmanSimproMCP
```

Coworkers see the new tools the next time they ask Claude something.
No restart on their side.

---

## Part 5 — Migrating to the old PC later

When you're ready to move from your dev PC to the dedicated old PC:

1. On the **old PC**: install Node.js, git. Clone + build (Part 1 Step 1).
2. On the **old PC**: run `.\scripts\install-as-service.ps1` (Part 1 Step 2).
3. **Copy `tokens.json` and `audit.log`** from your dev PC to the old PC's
   project folder. The bearer tokens stay the same — coworkers don't have
   to reconfigure anything.
4. **Update the IP/hostname** in coworkers' Custom Connectors. If you set up
   a hostname like `goldman-server.local` on your network and made it point
   at the old PC, no client-side change is needed.
5. On your **dev PC**: `.\scripts\uninstall-service.ps1` to remove the
   service.

---

## Part 6 — If you can't run a server (Plan B fallback)

If for any reason the server PC is unavailable for an extended period:

- Coworkers can install the standalone version following
  [SETUP-GUIDE.md](SETUP-GUIDE.md) → uses STDIO mode on each PC.
- The standalone version was your `v0.1.0-stdio` snapshot. It still works
  exactly as it did before this server existed.
- Coworkers don't lose any functionality — same 57 tools.
- They use **their own Simpro API key directly** in their Claude Desktop
  config (no bearer token, no server).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Get-Service GoldmanSimproMCP` returns "Stopped" | `Start-Service GoldmanSimproMCP`. If it won't start, check Event Viewer → Application → source `GoldmanSimproMCP`. |
| Coworker says "connection refused" | The service is down, or their PC can't reach this PC. Check `Test-NetConnection -ComputerName <this-pc-ip> -Port 3001` from their PC. |
| Coworker says "401 Unauthorized" | Their bearer token is wrong, expired, or revoked. Check `list-users.ps1`. |
| Coworker says "403 Forbidden" | Their token doesn't have access to that company. Re-run `add-user.ps1` for them with the right company access. |
| All coworkers suddenly get errors | Service crashed. Check Event Viewer. Often: ran out of disk for `audit.log`, or Node.js was uninstalled. |
| Audit log is huge | Rotate manually: `Move-Item audit.log "audit-$(Get-Date -Format yyyy-MM-dd).log"; Restart-Service GoldmanSimproMCP`. (No automatic rotation in v0.1.0.) |
