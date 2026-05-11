// src/http/admin-templates.ts
// HTML templates for the admin dashboard. Kept separate from admin.ts so
// the handler logic stays scannable.

import type { TokenRecord } from "./tokens.js";
import { createHash } from "node:crypto";

// Admin pages permit inline scripts because we use a small inline `onsubmit`
// confirm() on destructive actions. All interpolations into HTML go through
// esc(), so no user content reaches script context. Access is gated by
// requireAdmin so only trusted admins can render these pages.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";
export const ADMIN_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** SHA-256 hash of a Simpro API key (used as URL-safe identifier). */
export function keyHash(simproApiKey: string): string {
  return createHash("sha256").update(simproApiKey).digest("hex");
}

const STYLE = `
  body { font-family: -apple-system, "Segoe UI", sans-serif; background:#f5f7fa;
         color:#222; margin:0; padding:24px; }
  h1 { color:#0f4c75; margin:0 0 16px; }
  .nav { margin-bottom:16px; }
  .nav a { color:#0f4c75; margin-right:12px; text-decoration:none; font-weight:600; }
  table { width:100%; background:#fff; border-collapse:collapse;
          box-shadow:0 1px 3px rgba(0,0,0,0.08); }
  th, td { padding:8px 12px; border-bottom:1px solid #eef; text-align:left;
           font-size:13px; }
  th { background:#0f4c75; color:#fff; font-weight:600; }
  tr:hover { background:#f9fafc; }
  .actions form { display:inline; margin:0 4px 0 0; }
  .actions button { background:#0f4c75; color:#fff; border:none; padding:4px 10px;
                    border-radius:3px; cursor:pointer; font-size:12px; }
  .actions button.danger { background:#c0392b; }
  .badge { display:inline-block; padding:2px 6px; border-radius:3px; font-size:11px; }
  .badge.admin { background:#fce4a6; color:#7d5800; }
  .badge.write { background:#d4eed4; color:#1c6b1c; }
  .badge.readonly { background:#eee; color:#666; }
  pre { background:#0e1726; color:#dde; padding:12px; border-radius:4px;
        overflow:auto; font-size:12px; }
  .empty { color:#999; padding:24px; text-align:center; }
  form.create { background:#fff; padding:16px; margin-bottom:16px;
                box-shadow:0 1px 3px rgba(0,0,0,0.08); }
  form.create input { width:300px; padding:6px; border:1px solid #ccc; border-radius:3px; }
  form.create button { background:#0f4c75; color:#fff; border:none;
                       padding:6px 14px; border-radius:3px; cursor:pointer; }
`;

const NAV = `<div class="nav">
  <a href="/admin">Users</a>
  <a href="/admin/audit">Audit log</a>
  <a href="/admin/users/new">Create user manually</a>
</div>`;

export function renderDashboard(adminName: string, users: Array<{ smcpToken: string; record: TokenRecord }>): string {
  const rows = users.length === 0
    ? `<tr><td colspan="7" class="empty">No users enrolled yet.</td></tr>`
    : users.map(u => {
        const hash = keyHash(u.record.simproApiKey);
        const adminBadge = u.record.isAdmin ? `<span class="badge admin">admin</span>` : "";
        const writeBadge = u.record.writeEnabled
          ? `<span class="badge write">writes</span>`
          : `<span class="badge readonly">read-only</span>`;
        const toggleLabel = u.record.writeEnabled ? "Disable writes" : "Enable writes";
        const last = u.record.lastUsedAt ? esc(u.record.lastUsedAt.slice(0, 10)) : "—";
        const created = u.record.createdAt ? esc(u.record.createdAt.slice(0, 10)) : "—";
        return `<tr>
          <td>${esc(u.record.name)} ${adminBadge}</td>
          <td>${esc(u.record.companyAccess.join(", "))}</td>
          <td>${writeBadge}</td>
          <td>${esc(u.record.enrolledVia ?? "add-user.sh")}</td>
          <td>${created}</td>
          <td>${last}</td>
          <td class="actions">
            <form method="POST" action="/admin/users/${hash}/toggle-write">
              <button>${toggleLabel}</button>
            </form>
            <form method="POST" action="/admin/users/${hash}/revoke"
                  onsubmit="return confirm('Revoke ${esc(u.record.name)}?');">
              <button class="danger">Revoke</button>
            </form>
          </td>
        </tr>`;
      }).join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Admin — Goldman Simpro AI tool</title>
<style>${STYLE}</style></head><body>
<h1>Admin · ${esc(adminName)}</h1>
${NAV}
<table>
  <thead><tr>
    <th>Name</th><th>Companies</th><th>Write</th><th>Enrolled via</th>
    <th>Created</th><th>Last used</th><th>Actions</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
}

export function renderAuditView(adminName: string, lines: string[]): string {
  const body = lines.length === 0 ? "<em>no entries</em>" : esc(lines.join("\n"));
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Admin · Audit</title><style>${STYLE}</style></head><body>
<h1>Audit log · ${esc(adminName)}</h1>
${NAV}
<pre>${body}</pre>
</body></html>`;
}

export function renderManualCreatePage(opts: { errorMessage?: string; submittedKey?: string; submittedName?: string } = {}): string {
  const err = opts.errorMessage ? `<div style="color:#c0392b;margin-bottom:12px;">${esc(opts.errorMessage)}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Admin · Create user manually</title><style>${STYLE}</style></head><body>
<h1>Create user manually</h1>${NAV}
<form class="create" method="POST" action="/admin/users">
${err}
<label>Coworker's full name<br><input type="text" name="name" required maxlength="100"
       value="${esc(opts.submittedName ?? "")}"></label><br><br>
<label>Coworker's Simpro API key<br><input type="password" name="simpro_key" required minlength="20" maxlength="200"
       value="${esc(opts.submittedKey ?? "")}"></label><br><br>
<button type="submit">Create</button>
</form>
</body></html>`;
}

export function renderManualCreateResult(record: TokenRecord, smcpToken: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Admin · User created</title><style>${STYLE}
details { background:#fff; padding:12px; border-radius:4px; margin-top:16px; }
details summary { cursor:pointer; color:#666; font-size:12px; }
.token { font-family: monospace; word-break: break-all; background:#f0f0f0;
         padding:8px; border-radius:3px; margin-top:8px; }
</style></head><body>
<h1>User created</h1>${NAV}
<p><b>Name:</b> ${esc(record.name)}<br>
<b>Companies:</b> ${esc(record.companyAccess.join(", "))}<br>
<b>Writes:</b> ${record.writeEnabled ? "enabled" : "disabled"}</p>
<p>Tell the coworker to open Claude Desktop, add the custom connector, and on the consent page paste <b>their Simpro API key</b> (not the smcp_ token below). The server will find their existing record.</p>
<details>
  <summary>Advanced: copy smcp_ token (only needed for legacy / debug)</summary>
  <div class="token">${esc(smcpToken)}</div>
</details>
</body></html>`;
}
