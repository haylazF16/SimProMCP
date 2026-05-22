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
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a small inline SVG bar chart. Pure function: input data + labels,
 * output HTML string. Used by the usage dashboard for the time-pattern
 * charts. Bars are 16 px wide with 2 px gaps; height scales so the tallest
 * bar reaches `maxHeight`. Empty / all-zero input renders as flat bars.
 */
export function renderBarChart(
  values: number[],
  opts: { labelEvery: number; axisLabels: string[]; maxHeight?: number },
): string {
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const barW = 16;
  const gap = 2;
  const maxH = opts.maxHeight ?? 50;
  const width = Math.max(0, values.length * (barW + gap) - gap);
  const totalH = maxH + 18; // room for the x-axis labels under the bars
  const bars = values.map((v, i) => {
    const h = max === 0 ? 1 : Math.max(1, Math.round((v / max) * maxH));
    const x = i * (barW + gap);
    const y = maxH - h;
    return `<g><rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="#0f4c75"><title>${v}</title></rect></g>`;
  }).join("");
  const labels = values.map((_, i) => {
    if (opts.labelEvery <= 0 || i % opts.labelEvery !== 0) return "";
    const x = i * (barW + gap) + barW / 2;
    const label = opts.axisLabels[i] ?? "";
    return `<text x="${x}" y="${maxH + 14}" text-anchor="middle" font-size="10" fill="#888">${esc(label)}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalH}" viewBox="0 0 ${width} ${totalH}" role="img">${bars}${labels}</svg>`;
}

export function renderLoginPage(opts: { errorMessage?: string }): string {
  const err = opts.errorMessage
    ? `<div class="err">${esc(opts.errorMessage)}</div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Admin login — Goldman Simpro AI tool</title>
<style>
  body { font-family: -apple-system, "Segoe UI", sans-serif;
         background:#0f4c75; color:#fff; margin:0; padding:0; min-height:100vh;
         display:flex; align-items:center; justify-content:center; }
  .card { background:#fff; color:#222; max-width:480px; width:90%;
          padding:32px; border-radius:8px; box-shadow:0 8px 32px rgba(0,0,0,0.2); }
  h1 { margin:0 0 8px; font-size:20px; color:#0f4c75; }
  .sub { color:#666; font-size:14px; margin-bottom:24px; }
  label { display:block; margin:14px 0 6px; font-weight:600; font-size:14px; }
  input { width:100%; padding:10px; box-sizing:border-box;
          border:1px solid #ccc; border-radius:4px; font-size:14px;
          font-family: monospace; }
  button { width:100%; padding:12px; background:#0f4c75; color:#fff;
           border:none; border-radius:4px; font-size:15px; font-weight:600;
           cursor:pointer; margin-top:16px; }
  button:hover { background:#1b5e9c; }
  .err { background:#fff3f3; color:#c0392b; padding:10px; border-radius:4px;
         margin-bottom:16px; font-size:13px; }
  .help { font-size:12px; color:#888; margin-top:16px; line-height:1.5; }
</style></head><body>
<div class="card">
  <h1>Goldman Simpro admin</h1>
  <div class="sub">Sign in with your <code>smcp_</code> token. You'll stay
  signed in on this browser for 24 hours.</div>
  ${err}
  <form method="POST" action="/admin/login">
    <label for="smcp_token">Your smcp_ token</label>
    <input type="password" id="smcp_token" name="smcp_token" autocomplete="off"
           placeholder="smcp_..." required minlength="20" maxlength="200" autofocus>
    <button type="submit">Sign in</button>
  </form>
  <div class="help">
    This is the same token you'd use as a Bearer header when calling /admin
    from curl. If you don't have admin access, ask an existing admin to add
    <code>"isAdmin": true</code> to your record in tokens.json.
  </div>
</div>
</body></html>`;
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
  <form method="POST" action="/admin/logout" style="display:inline;margin-left:16px;">
    <button type="submit" style="background:none;border:none;color:#0f4c75;font-weight:600;cursor:pointer;padding:0;font-family:inherit;font-size:inherit;">Logout</button>
  </form>
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
                  class="confirm-form" data-confirm="Revoke ${esc(u.record.name)}?">
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
<script>
document.querySelectorAll('form.confirm-form').forEach(function(f) {
  f.addEventListener('submit', function(e) {
    if (!confirm(f.dataset.confirm)) e.preventDefault();
  });
});
</script>
</body></html>`;
}

/** Map a Simpro tool name to a short human-readable action description. */
function humanizeAction(tool: string): string {
  const m = tool.match(/^simpro_([a-z]+)_(.+)$/);
  if (!m) return tool;
  const verbMap: Record<string, string> = {
    search: "Searched",
    get: "Viewed",
    list: "Listed",
    create: "Created",
    update: "Updated",
    add: "Added",
    attach: "Attached",
  };
  const verb = verbMap[m[1]] ?? (m[1].charAt(0).toUpperCase() + m[1].slice(1));
  const noun = m[2].replace(/_/g, " ");
  return `${verb} ${noun}`;
}

/** Render an ISO timestamp as "5 min ago" / "2h ago" / "3d ago". */
function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Format ms duration as a tidy short string. */
function fmtDuration(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface ParsedAuditRow {
  ts: string;
  user: string;
  company: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  errorMessage?: string;
  details?: string;
}

function parseAuditLines(lines: string[]): ParsedAuditRow[] {
  const out: ParsedAuditRow[] = [];
  for (const raw of lines) {
    try {
      const o = JSON.parse(raw) as Partial<ParsedAuditRow>;
      if (typeof o?.ts !== "string" || typeof o?.tool !== "string") continue;
      out.push({
        ts: o.ts,
        user: typeof o.user === "string" ? o.user : "unknown",
        company: typeof o.company === "string" ? o.company : "—",
        tool: o.tool,
        ok: o.ok !== false,
        durationMs: typeof o.durationMs === "number" ? o.durationMs : 0,
        errorMessage: typeof o.errorMessage === "string" ? o.errorMessage : undefined,
        details: typeof o.details === "string" ? o.details : undefined,
      });
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/** Categorize a tool name into a coarse "kind" used by the result filter. */
function actionKind(tool: string): "view" | "search" | "list" | "create" | "update" | "other" {
  if (/^simpro_search_/.test(tool)) return "search";
  if (/^simpro_get_/.test(tool)) return "view";
  if (/^simpro_list_/.test(tool)) return "list";
  if (/^simpro_create_/.test(tool)) return "create";
  if (/^simpro_update_/.test(tool)) return "update";
  if (/^simpro_(add|attach)_/.test(tool)) return "create";
  return "other";
}

export type AuditViewContext =
  | { mode: "tail"; tailLimit: number }
  | {
      mode: "range";
      from: string;
      to: string;
      truncated: boolean;
      totalShown: number;
      cap: number;
      sources: string[];
    };

export function renderAuditView(
  adminName: string,
  lines: string[],
  ctx: AuditViewContext = { mode: "tail", tailLimit: 100 },
): string {
  const rows = parseAuditLines(lines).reverse(); // newest first
  const now = Date.now();

  // Build sorted lists for the filter dropdowns.
  const uniqUsers = Array.from(new Set(rows.map((r) => r.user))).sort();
  const uniqCompanies = Array.from(new Set(rows.map((r) => r.company))).sort();

  const tbody = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No activity recorded yet.</td></tr>`
    : rows.map((r) => {
      const absolute = new Date(r.ts).toLocaleString();
      const relative = relativeTime(r.ts, now);
      const action = humanizeAction(r.tool);
      const kind = actionKind(r.tool);
      const companyClass = r.company === "plumbing" ? "co-plumbing"
                         : r.company === "energy" ? "co-energy" : "co-other";
      const resultCell = r.ok
        ? `<span class="ok" title="Success">✓</span>`
        : `<span class="fail" title="${esc(r.errorMessage ?? "Failed")}">✗ failed</span>`;
      const rowClass = r.ok ? "" : ' class="row-fail"';
      // Combined searchable haystack for the free-text box.
      const haystack = `${r.user} ${r.company} ${action} ${r.tool} ${r.details ?? ""}`.toLowerCase();
      const detailsHtml = r.details
        ? `<div class="details">${esc(r.details)}</div>`
        : "";
      // data-ts is the epoch ms so the date-range filter can compare numerically.
      const tsEpoch = Date.parse(r.ts) || 0;
      return `<tr${rowClass} data-search="${esc(haystack)}"
                  data-user="${esc(r.user)}"
                  data-company="${esc(r.company)}"
                  data-result="${r.ok ? "ok" : "fail"}"
                  data-kind="${kind}"
                  data-ts="${tsEpoch}">
        <td class="when-cell" data-rel="${esc(relative)}" data-abs="${esc(absolute)}" title="Click to toggle exact time">${esc(relative)}</td>
        <td><b>${esc(r.user)}</b></td>
        <td><span class="badge ${companyClass}">${esc(r.company)}</span></td>
        <td>
          <div class="action">${esc(action)} <span class="raw" title="raw tool: ${esc(r.tool)}">·</span></div>
          ${detailsHtml}
        </td>
        <td class="num">${esc(fmtDuration(r.durationMs))}</td>
        <td>${resultCell}</td>
      </tr>`;
    }).join("");

  const summary = (() => {
    const users = new Set(rows.map((r) => r.user));
    const fails = rows.filter((r) => !r.ok).length;
    let label: string;
    let rangeBack = "";
    if (ctx.mode === "range") {
      label = `Showing <b id="visCount">${rows.length}</b> actions between
        <b>${esc(ctx.from)}</b> and <b>${esc(ctx.to)}</b>
        from <b>${users.size}</b> ${users.size === 1 ? "person" : "people"}`;
      if (ctx.truncated) {
        label += ` <span class="trunc-pill" title="The range contained more than ${ctx.cap} entries — narrow the dates if you need older entries from this range.">capped at ${ctx.cap}</span>`;
      }
      rangeBack = ` · <a href="/admin/audit" class="back-link">back to recent activity</a>`;
    } else {
      label = `Showing the last <b id="visCount">${rows.length}</b> actions
        from <b>${users.size}</b> ${users.size === 1 ? "person" : "people"}`;
    }
    return `<div class="summary">
      ${label}.
      ${fails > 0 ? `<span class="fail-pill">${fails} failed</span>` : ""}
      ${rangeBack}
    </div>`;
  })();

  // Default date inputs in the history form: if we're in a range view, prefill
  // them; otherwise leave blank.
  const fromVal = ctx.mode === "range" ? esc(ctx.from) : "";
  const toVal = ctx.mode === "range" ? esc(ctx.to) : "";
  // Today as max for the date picker so people don't accidentally pick future
  // dates (the audit log can't have future entries).
  const todayIso = new Date().toISOString().slice(0, 10);
  const historyForm = `<form class="history" method="GET" action="/admin/audit">
    <span class="history-label">Search history:</span>
    <label>From <input type="date" name="from" value="${fromVal}" max="${todayIso}" required></label>
    <label>To   <input type="date" name="to"   value="${toVal}"   max="${todayIso}" required></label>
    <button type="submit">Load</button>
    <span class="history-hint">Searches the live log plus all monthly archives within the range.</span>
  </form>`;

  const userOptions = ['<option value="">All users</option>']
    .concat(uniqUsers.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`))
    .join("");
  const companyOptions = ['<option value="">All companies</option>']
    .concat(uniqCompanies.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`))
    .join("");

  // Inline filter + click-to-toggle script. All client-side; no deps.
  const filterScript = `
    (function(){
      var $ = function(id){ return document.getElementById(id); };
      var fUser    = $('fUser');
      var fCompany = $('fCompany');
      var fResult  = $('fResult');
      var fKind    = $('fKind');
      var fRange   = $('fRange');
      var fText    = $('fText');
      var visCount = $('visCount');
      var rows = document.querySelectorAll('tbody tr[data-search]');

      function rangeCutoff() {
        var v = fRange.value;
        if (v === '24h') return Date.now() - 24*3600*1000;
        if (v === '7d')  return Date.now() - 7*24*3600*1000;
        if (v === '30d') return Date.now() - 30*24*3600*1000;
        return 0;
      }

      function apply() {
        var u = fUser.value;
        var c = fCompany.value;
        var r = fResult.value;
        var k = fKind.value;
        var t = fText.value.trim().toLowerCase();
        var cutoff = rangeCutoff();
        var shown = 0;
        for (var i=0;i<rows.length;i++) {
          var row = rows[i];
          var ok = true;
          if (u && row.getAttribute('data-user') !== u) ok = false;
          if (ok && c && row.getAttribute('data-company') !== c) ok = false;
          if (ok && r && row.getAttribute('data-result') !== r) ok = false;
          if (ok && k && row.getAttribute('data-kind') !== k) ok = false;
          if (ok && t && row.getAttribute('data-search').indexOf(t) < 0) ok = false;
          if (ok && cutoff > 0) {
            var ts = parseInt(row.getAttribute('data-ts'), 10);
            if (!ts || ts < cutoff) ok = false;
          }
          row.style.display = ok ? '' : 'none';
          if (ok) shown++;
        }
        if (visCount) visCount.textContent = String(shown);
      }
      [fUser, fCompany, fResult, fKind, fRange].forEach(function(el){
        if (el) el.addEventListener('change', apply);
      });
      if (fText) fText.addEventListener('input', apply);

      // Click any "When" cell to toggle relative <-> absolute time.
      var whens = document.querySelectorAll('.when-cell');
      for (var j=0;j<whens.length;j++) {
        whens[j].addEventListener('click', function(ev){
          var el = ev.currentTarget;
          var showingAbs = el.getAttribute('data-showing') === 'abs';
          if (showingAbs) {
            el.textContent = el.getAttribute('data-rel');
            el.setAttribute('data-showing', 'rel');
          } else {
            el.textContent = el.getAttribute('data-abs');
            el.setAttribute('data-showing', 'abs');
          }
        });
      }
    })();
  `;

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Activity log — Goldman Simpro admin</title>
<style>${STYLE}
  .summary { background:#fff; padding:10px 14px; border-radius:4px;
             box-shadow:0 1px 3px rgba(0,0,0,0.08); margin-bottom:12px;
             font-size:13px; color:#555; }
  .summary .fail-pill { background:#fdecea; color:#c0392b; padding:2px 8px;
                        border-radius:10px; margin-left:8px; font-weight:600; }
  .summary .trunc-pill { background:#fff3cd; color:#8a6d3b; padding:2px 8px;
                         border-radius:10px; margin-left:8px; font-weight:600;
                         cursor:help; }
  .summary .back-link { color:#0f4c75; text-decoration:none; font-weight:600; }
  .summary .back-link:hover { text-decoration:underline; }
  .history { background:#fff; padding:10px 14px; border-radius:4px;
             box-shadow:0 1px 3px rgba(0,0,0,0.08); margin-bottom:12px;
             display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .history-label { font-weight:600; color:#0f4c75; margin-right:4px; }
  .history label { font-size:13px; color:#444; }
  .history input[type=date] { margin-left:4px; padding:5px 8px; font-size:13px;
                              border:1px solid #ccd; border-radius:4px; }
  .history button { background:#0f4c75; color:#fff; border:none;
                    padding:6px 14px; border-radius:4px; cursor:pointer;
                    font-size:13px; font-weight:600; }
  .history button:hover { background:#1b5e9c; }
  .history-hint { font-size:11px; color:#888; margin-left:auto; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center;
             margin-bottom:12px; background:#fff; padding:10px 12px;
             border-radius:4px; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  .filters select, .filters input[type=text] {
    padding:6px 8px; font-size:13px; border:1px solid #ccd; border-radius:4px;
    background:#fff; color:#222;
  }
  .filters input[type=text] { flex:1; min-width:200px; }
  .filters label { font-size:12px; color:#666; margin-right:4px; }
  .filters button.clear { background:#eee; border:1px solid #ccd; padding:6px 10px;
                          border-radius:4px; cursor:pointer; font-size:12px; }
  .filters button.clear:hover { background:#e0e0e0; }
  td.when-cell { cursor:pointer; user-select:none; }
  td.when-cell:hover { background:#eaf2fb; }
  td.num { font-variant-numeric: tabular-nums; color:#666; }
  .row-fail { background:#fdecea !important; }
  .ok   { color:#1c6b1c; font-weight:700; }
  .fail { color:#c0392b; font-weight:700; }
  .raw  { color:#bbb; cursor:help; }
  .action { font-weight:500; }
  .details { color:#666; font-size:12px; margin-top:2px;
             font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .badge.co-plumbing { background:#e0ecff; color:#0f4c75; }
  .badge.co-energy   { background:#e6f7e6; color:#1c6b1c; }
  .badge.co-other    { background:#eee;    color:#666; }
  .legend { color:#888; font-size:11px; margin-top:6px; }
</style></head><body>
<h1>Activity log · ${esc(adminName)}</h1>
${NAV}
${historyForm}
${summary}
<div class="filters">
  <label>User</label>
  <select id="fUser">${userOptions}</select>
  <label>Company</label>
  <select id="fCompany">${companyOptions}</select>
  <label>Result</label>
  <select id="fResult">
    <option value="">All</option>
    <option value="ok">Successful</option>
    <option value="fail">Failed</option>
  </select>
  <label>Action</label>
  <select id="fKind">
    <option value="">All</option>
    <option value="search">Search</option>
    <option value="view">View</option>
    <option value="list">List</option>
    <option value="create">Create / Add</option>
    <option value="update">Update</option>
  </select>
  <label>Time</label>
  <select id="fRange">
    <option value="">All</option>
    <option value="24h">Last 24 hours</option>
    <option value="7d">Last 7 days</option>
    <option value="30d">Last 30 days</option>
  </select>
  <input id="fText" type="text" placeholder="Search any text (e.g. '#1234', 'goldman')…" autocomplete="off">
  <button class="clear" type="button" onclick="document.querySelectorAll('.filters select').forEach(function(s){s.value='';});document.getElementById('fText').value='';document.getElementById('fText').dispatchEvent(new Event('input'));">Clear</button>
</div>
<table>
  <thead><tr>
    <th style="width:130px;">When</th>
    <th style="width:140px;">Who</th>
    <th style="width:100px;">Company</th>
    <th>What they did</th>
    <th style="width:80px;">Time</th>
    <th style="width:90px;">Result</th>
  </tr></thead>
  <tbody>${tbody}</tbody>
</table>
<div class="legend">Click a date to see the exact time (click again to switch back). Hover the "·" after each action for the raw tool name. Showing newest first, capped at 100 entries.</div>
<script>${filterScript}</script>
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
