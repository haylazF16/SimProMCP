# Admin dashboard

The admin dashboard at `/admin` lets admins manage enrolled users without
SSHing to the Ubuntu server.

## Granting admin to a user

There's no in-app "make this user admin" button in v1 — it's a one-line
edit to `tokens.json`.

1. SSH to Ubuntu.
2. `sudo nano /opt/simpro-mcp/tokens.json`
3. Find the target user's record by `name`.
4. Add `"isAdmin": true,` inside their record (e.g. just before `"createdAt"`).
5. Save.

The next request loads the updated file (mtime cache). No restart needed.

## What the dashboard does (v1)

| Action | URL | Description |
|---|---|---|
| List users | `GET /admin` | All enrolled users with company access, write status, last-used, enrolled-via |
| Revoke user | `POST /admin/users/:hash/revoke` | Deletes the user's record. Their Claude Desktop connector starts 401-ing. |
| Toggle write access | `POST /admin/users/:hash/toggle-write` | Flips writeEnabled on/off |
| View audit log | `GET /admin/audit` | Last 100 lines of `/opt/simpro-mcp/audit.log` |
| Create user manually | `GET /admin/users/new` + `POST /admin/users` | Same validation as self-service but admin-driven. Useful for non-technical coworkers. |

## How admin auth works

Admins authenticate using their normal `smcp_` token (the one Claude Desktop
uses to call MCP endpoints). Open the dashboard in a private/incognito browser
window with the Authorization header set, or use a browser extension that
injects headers.

Easiest: open the dashboard from a Claude Desktop session by asking Claude
"open the admin dashboard URL with my smcp_ token" — but most browsers won't
let you set Authorization for navigation requests. In practice, use `curl`
for one-off admin actions, or set up a small bookmarklet that adds the
header for browser-based use.

A future v2 may add a simple session cookie login flow for the dashboard so
the smcp_ token bookmarklet isn't needed.

## What the dashboard doesn't do (v2+)

- Self-service "grant admin to another user"
- Token rotation
- Bulk export
- Edit display name
