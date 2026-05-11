# Self-service enrollment + admin dashboard — design

**Status:** Draft, ready for review
**Date:** 2026-05-11
**Author:** Tayfun + Claude (brainstorming session)

## Problem

Today, onboarding a new coworker requires Tayfun to:
1. Receive the coworker's Simpro API key over Teams/WhatsApp.
2. SSH to Ubuntu and run `add-user.sh` interactively.
3. Send the generated `smcp_` token back to the coworker.
4. Coworker pastes that token on the OAuth consent page.

Two tokens (Simpro key + `smcp_`) confuse non-technical users. Tayfun is a single point of failure for onboarding. Scale beyond a handful of users isn't realistic.

## Goal

Replace the manual onboarding loop with a self-service web form where coworkers paste only their Simpro API key. The system validates the key against Simpro, auto-detects company access, and completes the OAuth handshake. Tayfun is never in the critical path.

Add an admin dashboard so Tayfun can view enrolled users, revoke them, toggle write access, view recent audit log, and manually create users when needed — all without SSHing to Ubuntu.

## Out of scope (v2 candidates)

- Self-service token rotation ("my laptop was stolen, give me a new smcp_")
- Per-device tokens (every device gets its own smcp_)
- Email/SSO identity instead of Simpro key as identity
- Invite codes (rejected — Simpro key validation alone is sufficient gating)

## Security premise

**A valid Goldman Simpro API key is the identity proof.** Rationale: anyone holding a valid key already has equivalent Simpro access through Simpro's own web UI and REST API. The MCP server is a UX wrapper around that — it never grants more access than the key itself permits. Therefore no separate invite/email verification is needed; the key's validity (verified live against Simpro) IS the gate.

Risks accepted:
- **Former employees with not-yet-disabled Simpro accounts** could self-enroll. Mitigation: not the AI tool's job; Tayfun must disable Simpro accounts on offboarding (existing operational requirement).
- **Stolen Simpro keys** could be used to enroll. Mitigation: attacker can already use Simpro directly with a stolen key, so the AI tool doesn't extend privilege.

## Design

### 1. Enrollment UX — replace consent page

The existing `/authorize/consent` page is rewritten to accept a Simpro API key instead of an `smcp_` token. From Claude Desktop's perspective the OAuth flow is unchanged (same `/authorize` → `/token` sequence). Coworkers never see an `smcp_` token at any point.

**Form fields:**
- **Your name** — pre-filled by live probe from Simpro `/info`, editable; required to be non-empty on submit
- **Your Simpro API key** — password-style field

**Live probe (debounced AJAX, fires on key-paste):**
```
POST /enroll/probe { simproApiKey }
→ { valid: true, name: "Tayfun Isik", companyAccess: ["plumbing", "energy"] }
   OR
   { valid: false, reason: "invalid_key" | "no_company_access" | "simpro_unreachable" }
```

Used to pre-fill the name field and to give the user immediate feedback. Full validation re-runs on submit.

**Form submit (POST /authorize/consent):**

Server logic:
```
1. Sanity-check shape of Simpro key (length, charset).
2. Probe Simpro /info: GET ${SIMPRO_BASE_URL}/api/v1.0/info/
   401/403 → return inline error "Simpro rejected this key."
   network error → "Simpro unreachable — try again."
3. Probe Plumbing: GET ${SIMPRO_BASE_URL}/api/v1.0/companies/4/jobs/?pageSize=1
   200 → grants plumbing.
4. Probe Energy: GET ${SIMPRO_BASE_URL}/api/v1.0/companies/37/jobs/?pageSize=1
   200 → grants energy.
5. If neither company granted → "No access to Goldman companies."
6. Build TokenRecord { name, simproApiKey, companyAccess[], writeEnabled: true,
                       createdAt, enrolledVia: "self-service" }.
7. Lookup tokens.json by simproApiKey (linear scan, Goldman scale <50 users):
   - existing record → return existing smcp_ token (idempotent re-enrollment)
   - new → generate smcp_<32 base64url bytes>, save record, return smcp_
8. Issue OAuth code (existing logic). Redirect to claude.ai.
```

### 2. Self-service "Remove me"

Same enrollment page has a **"Remove my account"** link beneath the Authorize button → opens `/unenroll` page with a confirmation form.

**Form fields:**
- **Your Simpro API key** — same field as enrollment, proves ownership

**Server logic (POST /unenroll):**
```
1. Probe Simpro /info to verify the key is still valid (so a stale leaked key
   can't be used to wipe a record).
2. Look up tokens.json by simproApiKey:
   - found → delete record, return success
   - not found → return success anyway (don't leak who's enrolled)
3. Audit log: { event: "unenroll", keySuffix, outcome }
```

Result page: "Your account has been removed. Your Claude Desktop connector will stop working until you re-enroll."

### 3. Admin dashboard

Lives at `GET /admin`. Protected by a custom middleware that:
1. Reads the `Authorization: Bearer smcp_xxx` header.
2. Looks up the user in `tokens.json`.
3. Allows the request only if the record has `isAdmin: true`.

**Admin bootstrap:** Tayfun manually edits `tokens.json` once to add `"isAdmin": true` to his existing record. Future admin grants (e.g. Sinan) are done via the same one-line JSON edit OR via a new "Grant admin" action on another admin's user row.

**Dashboard actions for v1:**
- **View all enrolled users:** table with name, companyAccess, writeEnabled, isAdmin, createdAt, lastUsedAt, enrolledVia, and a `smcp_***last4` token preview (full token never displayed).
- **Revoke user:** button on each row → confirmation → deletes the record. Audit logs the action.
- **Toggle write access:** flip writeEnabled per user. Audit logs the action.
- **View last 100 audit log lines:** linked page `/admin/audit` showing tail of `audit.log` formatted.
- **Manual user creation:** "Create user manually" button opens a form with Simpro key field + auto-detected name. Same validation as self-service enrollment. Result page (option C) shows a clean success message with the new user's name, plus a collapsible "Advanced: copy smcp_ token" section for edge cases.

**Dashboard styling:** minimal HTML + inline CSS, same look as the existing consent page. No JS framework. Single HTML response per page.

### 4. Data model changes

**`tokens.json`** — additive only, no breaking schema change:

```json
{
  "tokens": {
    "smcp_xxx": {
      "name": "Tayfun Isik",
      "simproApiKey": "1d81c7ec...",
      "companyAccess": ["plumbing", "energy"],
      "writeEnabled": true,
      "createdAt": "2026-05-11T...",
      "lastUsedAt": "...",
      "enrolledVia": "self-service",   // NEW: "self-service" | "manual" | "add-user.sh"
      "isAdmin": true                   // NEW: optional, defaults false
    }
  }
}
```

The runtime validator in `tokens.ts` is updated to accept these two new optional fields.

### 5. Endpoints summary

| Method + Path | Auth | Purpose |
|---|---|---|
| `GET /authorize` | none | Renders the enrollment form (existing) |
| `POST /enroll/probe` | none, rate-limited | Live AJAX validation of Simpro key |
| `POST /authorize/consent` | none, rate-limited | Enrollment submit; creates/finds user; completes OAuth |
| `GET /unenroll` | none | Renders the unenroll confirmation form |
| `POST /unenroll` | none, rate-limited | Validates key, deletes record |
| `GET /admin` | admin smcp_ | Dashboard HTML |
| `GET /admin/audit` | admin smcp_ | Last 100 audit log lines |
| `POST /admin/users` | admin smcp_ | Manual user creation (uses same logic as self-service) |
| `POST /admin/users/:simproKeyHash/revoke` | admin smcp_ | Deletes user record |
| `POST /admin/users/:simproKeyHash/toggle-write` | admin smcp_ | Flips writeEnabled |

Per-user URLs key off a SHA-256 of `simproApiKey` (full 64-char hex digest, computed server-side, so admin URLs don't leak the full token via Referer headers or screenshots).

**Granting admin to other users in v1:** Tayfun edits `tokens.json` manually to add `"isAdmin": true` to the target user's record. A self-service "Grant admin" action on the dashboard is deferred to v2 to avoid the v1 scope blowing up.

### 6. Code surface

```
src/http/oauth.ts                – consent page logic rewritten (~150 lines net new)
src/http/enroll.ts               – NEW: shared enrollment helpers (validate, create, lookup)
src/http/admin.ts                – NEW: admin dashboard router + middleware
src/http/server.ts               – mount /admin and /unenroll routes
src/http/tokens.ts               – validator accepts enrolledVia + isAdmin fields; add lookupBySimproKey() helper
src/simpro/client.ts             – verifyApiKey() helper + probeCompany(id) helper
scripts/add-user.sh              – kept for legacy / disaster recovery, optional
docs/COWORKER-CONNECT.md         – simplified to the new flow
docs/ADMIN.md                    – NEW: how admin dashboard works, how to grant admin
```

### 7. Rate limits

| Endpoint | Limit | Window |
|---|---|---|
| `POST /enroll/probe` | 30 | 5 min |
| `POST /authorize/consent` | 10 | 15 min (existing) |
| `POST /unenroll` | 5 | 15 min |
| `/admin/*` | 60 | 1 min |

Per IP via `express-rate-limit`. `trust proxy = "loopback"` stays.

### 8. Audit log entries (new event types)

```jsonl
{"ts":"...","event":"enroll.probe","ip":"...","keySuffix":"...af","outcome":"valid"}
{"ts":"...","event":"enroll.attempt","ip":"...","keySuffix":"...af","outcome":"success","name":"Jane Smith","companies":["plumbing"]}
{"ts":"...","event":"enroll.attempt","ip":"...","keySuffix":"...zz","outcome":"invalid_key"}
{"ts":"...","event":"unenroll","ip":"...","keySuffix":"...af","outcome":"success"}
{"ts":"...","event":"admin.action","actor":"Tayfun","action":"toggle-write","targetKeySuffix":"...af","newValue":true}
{"ts":"...","event":"admin.action","actor":"Tayfun","action":"revoke","targetKeySuffix":"...af"}
{"ts":"...","event":"admin.action","actor":"Tayfun","action":"create","targetKeySuffix":"...af","name":"Bob Jones"}
```

Only last-4 of any Simpro key is logged. Full keys never appear in audit.log.

### 9. Manual test plan

**T1 — Happy path self-service**
Sinan opens browser via Claude Desktop Connect → pastes Simpro key → name auto-fills → click Authorize → redirected back → Claude Desktop shows Connected. tokens.json has new entry, enrolledVia="self-service". Audit log shows success.

**T2 — Idempotent re-enrollment**
Sinan repeats from a different device. Same Simpro key. tokens.json count unchanged. Same smcp_ returned.

**T3 — Invalid Simpro key**
Garbage string. Simpro returns 401. Form shows "Simpro rejected this key." No tokens.json change. Audit logs `invalid_key`.

**T4 — Valid key but no Goldman access**
Test key from a different Simpro tenant. /info 200, but companies 4 and 37 both deny. Form shows "no company access" error.

**T5 — Self-service remove**
Sinan visits /unenroll → pastes Simpro key → clicks Remove → success. tokens.json no longer has his record. His Claude Desktop will 401 on next call. He can re-enroll any time.

**T6 — Admin views dashboard**
Tayfun (with isAdmin=true) opens /admin → sees the user table → clicks Toggle Write on Sinan's row → reload → flag flipped. Audit log records admin.action.

**T7 — Non-admin denied admin access**
Sinan opens /admin → 403 Forbidden.

**T8 — Admin creates user manually**
Tayfun clicks Create user manually → pastes a coworker's Simpro key (sent via WhatsApp) → name auto-fills → submit → success page shows clean confirmation; expanding "Advanced" reveals the smcp_ token. tokens.json has new record with enrolledVia="manual".

**T9 — Rate limiting**
35 probe requests in 5 minutes from one IP. 31st returns 429.

### 10. Rollout

1. Build, push, deploy to Ubuntu via existing `git pull && npm ci && npm run build && systemctl restart`.
2. Tayfun marks his own record `isAdmin: true` by editing `tokens.json` (one-line edit, restart not needed since `loadTokens` mtime-caches).
3. Tayfun smoke-tests T1–T8 himself with a throwaway Simpro test account.
4. Tayfun pilots with Sinan — sends Sinan the simplified one-page email below.
5. After Sinan onboards successfully, email all remaining staff.

### 11. Risks and unknowns

- **Simpro `/info` response shape varies.** If Goldman's tenant doesn't expose the linked employee's name there, name auto-detect silently degrades to a blank field. The form still requires the user to type the name before submit, so it remains functional.
- **Probe-on-keystroke could rate-limit Simpro itself** if many coworkers enroll simultaneously. Mitigation: server-side per-key throttle (1 probe per key per 2 seconds) on top of the per-IP express-rate-limit.
- **`enrolledVia` and `isAdmin` schema additions** must be picked up by the runtime validator in `tokens.ts` (currently strict). One small edit; tests cover.
- **Existing users (from `add-user.sh`) re-enrolling via the form** — the idempotent lookup finds their record and returns the existing smcp_. We do NOT overwrite their `enrolledVia` if it was `add-user.sh`. They keep their original provenance.

### 12. Simplified coworker email (preview)

> **Subject:** Set up the Goldman Simpro AI tool — 5 minutes
>
> Hi [Name],
>
> 1. **Get your Simpro API key:** log in to Simpro → gear icon → System → Setup → API Keys → Add → name it "[Your Name] - Claude Desktop" → save → copy the token immediately (Simpro only shows it once).
>
> 2. **Open Claude Desktop → Settings → Connectors → Add custom connector:**
>    - Name: `Goldman Plumbing`
>    - URL: `https://goldman-ubuntu.tail6b5a4b.ts.net/mcp/plumbing`
>    - Leave Advanced fields empty.
>    - Click Add.
>
> 3. **Click Connect.** Your browser opens a Goldman page. Paste your Simpro key (the one from step 1), check your name, click Authorize. You'll be returned to Claude Desktop and the connector will show Connected.
>
> 4. *(Optional)* Repeat steps 2-3 for `Goldman Energy` with URL `https://goldman-ubuntu.tail6b5a4b.ts.net/mcp/energy`.
>
> 5. **Test it:** in a new chat, ask "Use Goldman Plumbing to test the connection." You should see "Simpro connection OK. Company ID: 4."
>
> No second token to remember. No waiting on IT. If something breaks, send me a screenshot (blur the Simpro key).
>
> Cheers,
> Tayfun
