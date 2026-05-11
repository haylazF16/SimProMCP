# Admin dashboard

The admin dashboard at `/admin` lets admins manage enrolled users without
SSHing to the Ubuntu server. Sign in with your `smcp_` token, get a 24-hour
session cookie, and use the web UI like a normal app.

## Opening the dashboard

1. In any browser, go to:

   ```
   https://goldman-ubuntu.tail6b5a4b.ts.net/admin
   ```

2. You'll be redirected to `/admin/login`. Paste your `smcp_` token (the one
   from `tokens.json` for your record) and click **Sign in**.

3. You land on the user list. A 24-hour cookie keeps you signed in across
   tabs, refreshes, and new windows.

4. Use the **Logout** link in the nav to end the session early.

> If you don't have admin access yet, ask an existing admin to add
> `"isAdmin": true` to your record in `tokens.json`. See "Granting admin"
> below.

## What the dashboard can do

### Users page (`/admin`)

Lists every enrolled user with:

- **Name** (with an `admin` badge if `isAdmin: true`)
- **Companies** they have Simpro access to (Plumbing, Energy, or both)
- **Write** status badge (writes enabled or read-only)
- **Enrolled via** — `self-service` (web form), `manual` (admin created),
  or `add-user.sh` (legacy CLI)
- **Created** and **Last used** dates
- Per-row **actions**:
  - **Enable/Disable writes** — flips the user's `writeEnabled` flag.
    Effect is immediate; no restart needed.
  - **Revoke** — deletes the user's `tokens.json` record. Their Claude
    Desktop connector will 401 on the next call. They can re-enroll
    themselves via the consent page using their Simpro key — the new
    enrollment is treated as fresh (new `smcp_` token issued).

### Audit log (`/admin/audit`)

Shows the last 100 lines of `/opt/simpro-mcp/audit.log`. Every enrollment,
unenrollment, admin action, and tool call is captured here. Useful for:

- Checking who did what and when
- Verifying that a coworker's tool calls are being attributed to their
  own Simpro account (not a shared API user)
- Investigating "I thought I undid that" moments

### Create user manually (`/admin/users/new`)

For coworkers who can't navigate the consent page (rare, but happens).
Paste their **Simpro API key** + their name, click Create. The server:

1. Validates the key against Simpro (same probe as self-service)
2. Detects which companies they have access to (Plumbing/Energy/both)
3. Creates the `tokens.json` record
4. Shows you a success page with a collapsible "Advanced: copy `smcp_`
   token" section

In practice you don't need to copy the `smcp_` token. Just tell the
coworker:

> "You're set up. Open Claude Desktop, add the custom connector, click
> Connect, paste your Simpro API key on the consent page. The server
> will find your existing record and return the same token."

The manual-create flow is idempotent with self-service enrollment — they
share the same lookup-by-Simpro-key path, so creating manually then
having the coworker enroll themselves produces a single record (not a
duplicate).

## Granting admin to another user

There's no in-app "make this user admin" button in v1 — it's a one-line
edit to `tokens.json`.

1. SSH to Ubuntu.
2. `sudo nano /opt/simpro-mcp/tokens.json`
3. Find the target user's record by `name`.
4. Add `"isAdmin": true,` inside their record (e.g. just before
   `"createdAt"`).
5. Save (Ctrl+O, Enter, Ctrl+X).

The next request loads the updated file (mtime cache). No restart needed.
They can now sign into the admin dashboard with their own `smcp_` token.

## Auth mechanics (for the curious)

The dashboard auth resolves identity in this order:

1. **Session cookie** `goldman_admin_session=smcp_xxx` (set by
   `/admin/login`, HttpOnly + Secure + SameSite=Strict, 24h)
2. **Authorization: Bearer** header (for `curl` and scripts)

In either case the token must belong to a user whose record has
`isAdmin: true`. Non-admin tokens get a 403; unknown tokens get a 401.
Browser navigations (GET requests asking for HTML) that fail auth are
redirected to `/admin/login` instead of showing a bare error page.

You can still use `curl` from a shell when you want to script something:

```bash
curl -H "Authorization: Bearer smcp_xxx" \
     https://goldman-ubuntu.tail6b5a4b.ts.net/admin
```

Bookmarklets and header-injection browser extensions are no longer
needed.

## Operational tips

- **Revoke before offboarding.** When a coworker leaves Goldman, revoke
  their record on the dashboard BEFORE you disable their Simpro account.
  Otherwise their cached `smcp_` token still works against Simpro for
  the time between Simpro disable and tokens.json update.
- **Writes off for first 1–2 weeks.** A common pattern: let new users
  self-enroll (writes on by default for v1), but immediately toggle
  writes off on the dashboard. After a couple weeks of safe usage,
  toggle back on. This catches "the AI did something weird" before
  irreversible damage.
- **Audit log lives at `/opt/simpro-mcp/audit.log`** if you ever want
  to grep it from the terminal directly. The dashboard shows only the
  last 100 lines; older entries are still on disk.

## What the dashboard doesn't do (v2+ candidates)

- Self-service "grant admin to another user" (currently a JSON edit)
- Token rotation (no in-UI "regenerate `smcp_`" button)
- Bulk export to CSV
- Editing display name after creation
- Paginated audit log view
- Live tail / WebSocket dashboard
