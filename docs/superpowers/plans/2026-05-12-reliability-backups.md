# Reliability & monitoring (S6) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local tiered backups (tokens.json / audit.log / .env), a one-command health-check script, fatal-error logging, and a two-tier per-user MCP rate limiter to the Goldman Simpro MCP server.

**Architecture:** A pure in-memory sliding-window rate limiter (`src/http/rateLimit.ts`) hooked into the per-request MCP handler; three env vars added to the zod config. Backups/health are bash scripts driven by systemd timers — no app coupling. The audit backup uses a single rolling daily copy + monthly gzip archives to keep disk growth linear.

**Tech Stack:** Node.js 18+, TypeScript (ESM, strict), Express 4, zod, vitest 2.x (existing), bash + systemd timers (Ubuntu deploy target).

**Source spec:** `docs/superpowers/specs/2026-05-12-reliability-backups-design.md`

---

## File structure

### Files to create

| Path | Responsibility |
|---|---|
| `src/http/rateLimit.ts` | Pure sliding-window per-key limiter. One class, no Express coupling. Exposes `check(key): "ok" \| "soft" \| "hard"` + an idle-key sweep. |
| `tests/http/rateLimit.test.ts` | Unit tests (fake timers) for window expiry, soft/hard thresholds, one-warn-per-window, idle sweep. |
| `scripts/backup.sh` | `tokens` / `audit` / `env` / `prune` subcommands. Skip-if-unchanged, atomic, retention. |
| `scripts/restore.sh` | Guided restore: stop → validate → copy → start, with confirm prompt. |
| `scripts/status.sh` | One-screen health check, exit 0=healthy. |
| `scripts/simpro-mcp-backup-tokens.service` | systemd oneshot: runs `backup.sh tokens && backup.sh env && backup.sh prune`. |
| `scripts/simpro-mcp-backup-tokens.timer` | Every 15 min. |
| `scripts/simpro-mcp-backup-audit.service` | systemd oneshot: runs `backup.sh audit`. |
| `scripts/simpro-mcp-backup-audit.timer` | Daily 00:10. |

### Files to modify

| Path | Change |
|---|---|
| `src/config.ts` | Add `SIMPRO_RATE_WINDOW_MS`, `SIMPRO_RATE_SOFT_LIMIT`, `SIMPRO_RATE_HARD_LIMIT` (zod, defaults). |
| `src/http/server.ts` | Construct limiter; call it in `handleMcp` after companyAccess check; tag generic error handler `[srv-error]`; add `[fatal]` process handlers. |
| `.env.example` | Document the 3 new rate-limit vars. |
| `docs/ADMIN.md` | Backup/restore runbook + `status.sh` usage + the no-off-site-DR risk note. |
| `scripts/install-on-ubuntu.sh` | Create `backups/` (0700, service-owned); install + `enable --now` the two timers. |

---

## Phase 1 — Rate limiter (pure unit, TDD)

### Task 1: Write rate limiter tests

**Files:**
- Create: `tests/http/rateLimit.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/http/rateLimit.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RateLimiter } from "../../src/http/rateLimit.js";

describe("RateLimiter", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns 'ok' below the soft limit", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 3, hardLimit: 5 });
    expect(rl.check("u1")).toBe("ok");
    expect(rl.check("u1")).toBe("ok");
    expect(rl.check("u1")).toBe("ok"); // 3rd call, count=3, not > soft(3)
  });

  it("returns 'soft' the first time the soft limit is crossed, 'ok' after", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 2, hardLimit: 5 });
    expect(rl.check("u1")).toBe("ok");   // 1
    expect(rl.check("u1")).toBe("ok");   // 2 (== soft, not >)
    expect(rl.check("u1")).toBe("soft"); // 3 (> soft) -> warn once
    expect(rl.check("u1")).toBe("ok");   // 4 (> soft but already warned this window)
  });

  it("returns 'hard' once the hard limit is exceeded", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 2, hardLimit: 3 });
    rl.check("u1"); // 1
    rl.check("u1"); // 2
    rl.check("u1"); // 3 (== hard, not >)
    expect(rl.check("u1")).toBe("hard"); // 4 (> hard)
  });

  it("resets the count after the window elapses", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 1, hardLimit: 2 });
    rl.check("u1"); // 1
    rl.check("u1"); // 2 (== hard)
    expect(rl.check("u1")).toBe("hard"); // 3 (> hard)
    vi.advanceTimersByTime(1001);
    expect(rl.check("u1")).toBe("ok");   // window expired, count back to 1
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 1, hardLimit: 1 });
    rl.check("u1"); // u1 = 1 (== hard)
    expect(rl.check("u1")).toBe("hard"); // u1 = 2
    expect(rl.check("u2")).toBe("ok");   // u2 independent
  });

  it("re-arms the soft warning in a new window", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 1, hardLimit: 9 });
    rl.check("u1");                       // 1
    expect(rl.check("u1")).toBe("soft");  // 2 > soft, warn
    expect(rl.check("u1")).toBe("ok");    // 3, already warned
    vi.advanceTimersByTime(1001);
    rl.check("u1");                       // new window, 1
    expect(rl.check("u1")).toBe("soft");  // 2 > soft, warn again
  });

  it("sweep() removes keys with no recent activity", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 5, hardLimit: 9 });
    rl.check("u1");
    expect(rl.size()).toBe(1);
    vi.advanceTimersByTime(1001);
    rl.sweep();
    expect(rl.size()).toBe(0);
  });

  it("sweep() keeps keys with activity inside the window", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 5, hardLimit: 9 });
    rl.check("u1");
    vi.advanceTimersByTime(500);
    rl.sweep();
    expect(rl.size()).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -- tests/http/rateLimit.test.ts`
Expected: all fail — `src/http/rateLimit.js` does not exist.

### Task 2: Implement the rate limiter

**Files:**
- Create: `src/http/rateLimit.ts`

- [ ] **Step 1: Write the implementation**

```typescript
// src/http/rateLimit.ts
// Pure in-memory sliding-window rate limiter, keyed by an opaque string
// (we key by the smcp_ token). No Express/HTTP coupling — server.ts adapts
// the verdict to a JSON-RPC response.
//
// Verdicts:
//   "ok"   - under the soft limit, or over it but already warned this window
//   "soft" - JUST crossed the soft limit (emit ONE warn per key per window)
//   "hard" - over the hard ceiling (caller should reject the request)

export interface RateLimiterOptions {
  windowMs: number;
  softLimit: number;
  hardLimit: number;
}

interface Entry {
  hits: number[];      // request timestamps (ms) within the window
  warnedAt: number;    // timestamp of the last soft warning, 0 if none
}

export class RateLimiter {
  private readonly opts: RateLimiterOptions;
  private readonly map = new Map<string, Entry>();

  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
  }

  /** Record a hit for `key` and return the verdict. */
  check(key: string): "ok" | "soft" | "hard" {
    const now = Date.now();
    const cutoff = now - this.opts.windowMs;
    let e = this.map.get(key);
    if (!e) {
      e = { hits: [], warnedAt: 0 };
      this.map.set(key, e);
    }
    // Drop timestamps outside the window.
    if (e.hits.length && e.hits[0] <= cutoff) {
      e.hits = e.hits.filter((t) => t > cutoff);
    }
    // If the warning was issued in a now-expired window, re-arm it.
    if (e.warnedAt !== 0 && e.warnedAt <= cutoff) {
      e.warnedAt = 0;
    }
    e.hits.push(now);
    const count = e.hits.length;

    if (count > this.opts.hardLimit) {
      return "hard";
    }
    if (count > this.opts.softLimit) {
      if (e.warnedAt === 0) {
        e.warnedAt = now;
        return "soft";
      }
      return "ok";
    }
    return "ok";
  }

  /** Remove keys whose newest hit is outside the window. Call periodically. */
  sweep(): void {
    const cutoff = Date.now() - this.opts.windowMs;
    for (const [key, e] of this.map) {
      const newest = e.hits.length ? e.hits[e.hits.length - 1] : 0;
      if (newest <= cutoff) this.map.delete(key);
    }
  }

  /** Number of tracked keys (for tests / introspection). */
  size(): number {
    return this.map.size;
  }
}
```

- [ ] **Step 2: Run, verify pass**

Run: `npm test -- tests/http/rateLimit.test.ts`
Expected: 8 tests pass.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/http/rateLimit.ts tests/http/rateLimit.test.ts
git commit -m "feat(ratelimit): pure sliding-window per-key limiter"
```

---

## Phase 2 — Config vars + wire into server

### Task 3: Add rate-limit config vars

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add the three zod fields**

In `src/config.ts`, inside `ConfigSchema`, immediately AFTER the
`SIMPRO_PUBLIC_BASE_URL` line and BEFORE the closing `});`, add:

```typescript
  // Per-user MCP rate limiting (HTTP mode). Keyed by smcp_ token.
  // Soft = log one warning per user per window. Hard = reject with 429.
  // Defaults sized for a small internal team; tune in .env after observing
  // real traffic. A human chatting never approaches the soft limit; a
  // runaway tool-call loop trips the hard ceiling.
  SIMPRO_RATE_WINDOW_MS: intFromString(300_000, 1_000, 3_600_000),
  SIMPRO_RATE_SOFT_LIMIT: intFromString(120, 1, 100_000),
  SIMPRO_RATE_HARD_LIMIT: intFromString(300, 1, 100_000),
```

- [ ] **Step 2: Document in .env.example**

Append to the end of `.env.example`:

```
# --- Per-user MCP rate limiting (HTTP mode only) ---
# Sliding window keyed by the user's smcp_ token.
# Soft: exceeding this logs ONE [warn] line per user per window (no block).
# Hard: exceeding this rejects the call with a JSON-RPC 429-style error.
SIMPRO_RATE_WINDOW_MS=300000
SIMPRO_RATE_SOFT_LIMIT=120
SIMPRO_RATE_HARD_LIMIT=300
```

- [ ] **Step 3: Typecheck + full test suite (no regressions)**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all existing tests still pass (rate limiter 8 + prior 53 = 61).

- [ ] **Step 4: Commit**

```bash
git add src/config.ts .env.example
git commit -m "feat(config): SIMPRO_RATE_* env vars for per-user rate limiting"
```

### Task 4: Wire limiter into the MCP handler + fatal logging

**Files:**
- Modify: `src/http/server.ts`

- [ ] **Step 1: Import the limiter**

In `src/http/server.ts`, add to the import block near
`import { recordAudit } from "./audit.js";`:

```typescript
import { RateLimiter } from "./rateLimit.js";
```

- [ ] **Step 2: Construct the limiter + periodic sweep inside `runHttp`**

In `src/http/server.ts`, inside `runHttp({ config })`, immediately after
`const app = express();`, add:

```typescript
  // Per-user MCP rate limiter (in-memory, resets on restart — acceptable:
  // a restart already interrupts any runaway loop).
  const mcpRateLimiter = new RateLimiter({
    windowMs: config.SIMPRO_RATE_WINDOW_MS,
    softLimit: config.SIMPRO_RATE_SOFT_LIMIT,
    hardLimit: config.SIMPRO_RATE_HARD_LIMIT,
  });
  const rateSweep = setInterval(
    () => mcpRateLimiter.sweep(),
    config.SIMPRO_RATE_WINDOW_MS,
  );
  rateSweep.unref(); // don't keep the process alive just for the sweep
```

- [ ] **Step 3: Apply the limiter in `handleMcp`**

In `src/http/server.ts`, find the block in `handleMcp` that ends the
companyAccess check (the `if (!auth.record.companyAccess.includes(company))`
block and its closing `}`). Immediately AFTER that closing `}` and BEFORE
`const userConfig = configForUser(...)`, insert:

```typescript
    const verdict = mcpRateLimiter.check(auth.token);
    if (verdict === "hard") {
      log.warn(`[rate] HARD user=${auth.record.name.replace(/[\r\n\t]/g, " ").slice(0, 80)} company=${company}`);
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32004, message: "Rate limit exceeded — wait a few minutes and try again." },
        id: null,
      });
      return;
    }
    if (verdict === "soft") {
      log.warn(`[rate] SOFT user=${auth.record.name.replace(/[\r\n\t]/g, " ").slice(0, 80)} company=${company}`);
    }
```

(The `.replace().slice()` mirrors the existing log-sanitisation pattern used
elsewhere for user-controlled names.)

- [ ] **Step 4: Tag the generic error handler**

In `src/http/server.ts`, find the generic Express error handler. It
currently logs something like
`log.error(\`Unhandled HTTP error: ${maskToken(err.message)}\`)`.
Change that log line to prefix with `[srv-error]`:

```typescript
    log.error(`[srv-error] Unhandled HTTP error: ${maskToken(err.message)}`);
```

(Only change the log string; leave the response behaviour unchanged.)

- [ ] **Step 5: Add process-fatal handlers**

In `src/http/server.ts`, inside `runHttp`, immediately BEFORE
`return new Promise((resolve, reject) => {` (the `app.listen` block at the
end), add:

```typescript
  process.on("uncaughtException", (err) => {
    log.error(`[fatal] uncaughtException: ${maskToken(err instanceof Error ? (err.stack ?? err.message) : String(err))}`);
    // Let systemd Restart=always bring us back; exit so we don't run degraded.
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error(`[fatal] unhandledRejection: ${maskToken(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))}`);
    process.exit(1);
  });
```

(`maskToken` is already imported in this file — verify the import line
`import { log, maskToken } from "../logger.js";` exists; it does.)

- [ ] **Step 6: Typecheck + build + tests**

Run: `npm run typecheck && npm run build && npm test`
Expected: all exit 0; 61 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/http/server.ts
git commit -m "feat(server): per-user rate limiting + [srv-error]/[fatal] logging"
```

---

## Phase 3 — Backup / restore / status scripts

> These are bash, tested manually on Ubuntu (Phase 6). They must be
> POSIX-ish bash, `set -euo pipefail`, and never touch the running service
> except `restore.sh` which explicitly stops/starts it.

### Task 5: backup.sh

**Files:**
- Create: `scripts/backup.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# scripts/backup.sh — local tiered backups for the Simpro MCP server.
#
# Subcommands:
#   tokens   copy tokens.json if it differs (sha256) from the newest backup
#   env      copy .env if it differs (sha256) from the newest backup
#   audit    refresh the rolling daily copy; on the 1st, archive prev month
#   prune    apply retention (tokens: newest 96; env: newest 5)
#
# Paths are derived from APP_DIR (default /opt/simpro-mcp). Override via env
# for testing: APP_DIR=/tmp/test scripts/backup.sh tokens
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/simpro-mcp}"
BK="${APP_DIR}/backups"
TOKENS="${APP_DIR}/tokens.json"
ENVF="${APP_DIR}/.env"
AUDIT="${APP_DIR}/audit.log"

mkdir -p "${BK}/tokens" "${BK}/audit" "${BK}/env"
chmod 700 "${BK}"

ts() { date -u +%Y%m%dT%H%M%SZ; }

# newest_file DIR -> prints newest file path by name (ISO ts sorts lexically)
newest_file() {
  local d="$1"
  ls -1 "${d}" 2>/dev/null | sort | tail -n1 | sed "s|^|${d}/|"
}

snapshot_if_changed() {
  local src="$1" dir="$2" prefix="$3"
  [ -f "${src}" ] || { echo "skip: ${src} missing"; return 0; }
  local newest cur new
  newest="$(newest_file "${dir}")"
  cur="$(sha256sum "${src}" | awk '{print $1}')"
  if [ -n "${newest}" ] && [ -f "${newest}" ]; then
    new="$(sha256sum "${newest}" | awk '{print $1}')"
    if [ "${cur}" = "${new}" ]; then echo "unchanged: ${prefix}"; return 0; fi
  fi
  local out="${dir}/${prefix}.$(ts).bak"
  cp "${src}" "${out}.tmp" && mv "${out}.tmp" "${out}"
  echo "wrote: ${out}"
}

cmd_tokens() { snapshot_if_changed "${TOKENS}" "${BK}/tokens" "tokens.json"; }
cmd_env()    { snapshot_if_changed "${ENVF}"   "${BK}/env"    "env"; }

cmd_audit() {
  [ -f "${AUDIT}" ] || { echo "skip: ${AUDIT} missing"; return 0; }
  # Rolling current full copy (single overwritten file).
  cp "${AUDIT}" "${BK}/audit/audit.log.current.bak.tmp"
  mv "${BK}/audit/audit.log.current.bak.tmp" "${BK}/audit/audit.log.current.bak"
  echo "wrote: ${BK}/audit/audit.log.current.bak"
  # On the 1st of the month, archive the PREVIOUS month's lines as gzip.
  if [ "$(date -u +%d)" = "01" ]; then
    local prev y m arc
    prev="$(date -u -d 'last month' +%Y-%m 2>/dev/null || date -u -v-1m +%Y-%m)"
    arc="${BK}/audit/audit-${prev}.log.gz"
    if [ ! -f "${arc}" ]; then
      # Lines whose JSON "ts" begins with the previous YYYY-MM.
      grep "\"ts\":\"${prev}" "${AUDIT}" 2>/dev/null | gzip -c > "${arc}.tmp" \
        && mv "${arc}.tmp" "${arc}" \
        && echo "archived: ${arc}" \
        || { rm -f "${arc}.tmp"; echo "no lines for ${prev}, skipped archive"; }
    fi
  fi
}

prune_dir() {
  local dir="$1" keep="$2"
  local n
  n="$(ls -1 "${dir}" 2>/dev/null | wc -l)"
  if [ "${n}" -gt "${keep}" ]; then
    ls -1 "${dir}" | sort | head -n "$((n - keep))" | while read -r f; do
      rm -f "${dir}/${f}"; echo "pruned: ${dir}/${f}"
    done
  fi
}

cmd_prune() {
  prune_dir "${BK}/tokens" 96
  prune_dir "${BK}/env" 5
  # Audit: rolling copy is a single file; monthly gzips kept forever.
}

case "${1:-}" in
  tokens) cmd_tokens ;;
  env)    cmd_env ;;
  audit)  cmd_audit ;;
  prune)  cmd_prune ;;
  *) echo "usage: $0 {tokens|env|audit|prune}" >&2; exit 2 ;;
esac
```

- [ ] **Step 2: Make executable + commit**

```bash
chmod +x scripts/backup.sh
git add scripts/backup.sh
git update-index --chmod=+x scripts/backup.sh
git commit -m "feat(backup): tiered local backup script (tokens/env/audit/prune)"
```

### Task 6: restore.sh

**Files:**
- Create: `scripts/restore.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# scripts/restore.sh — guided restore of tokens.json or .env from a backup.
#
# Usage:
#   sudo scripts/restore.sh tokens /opt/simpro-mcp/backups/tokens/tokens.json.<TS>.bak
#   sudo scripts/restore.sh env    /opt/simpro-mcp/backups/env/env.<TS>.bak
#
# Stops the service, validates, copies, restarts. Confirm prompt before write.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/simpro-mcp}"
KIND="${1:-}"
SRC="${2:-}"

case "${KIND}" in
  tokens) DEST="${APP_DIR}/tokens.json" ;;
  env)    DEST="${APP_DIR}/.env" ;;
  *) echo "usage: $0 {tokens|env} <backup-file>" >&2; exit 2 ;;
esac

[ -f "${SRC}" ] || { echo "backup file not found: ${SRC}" >&2; exit 1; }

if [ "${KIND}" = "tokens" ]; then
  # Validate JSON before we overwrite the live file.
  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${SRC}" 2>/dev/null; then
    echo "REFUSING: ${SRC} is not valid JSON" >&2; exit 1
  fi
fi

echo "About to restore:"
echo "  from: ${SRC}"
echo "  to:   ${DEST}"
read -r -p "Type 'yes' to proceed: " ans
[ "${ans}" = "yes" ] || { echo "aborted"; exit 0; }

echo "Stopping simpro-mcp..."
systemctl stop simpro-mcp

cp "${DEST}" "${DEST}.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
cp "${SRC}" "${DEST}.tmp" && mv "${DEST}.tmp" "${DEST}"
chown simpro-mcp:simpro-mcp "${DEST}" 2>/dev/null || true
chmod 600 "${DEST}"

echo "Starting simpro-mcp..."
systemctl start simpro-mcp
sleep 2
systemctl is-active simpro-mcp && echo "restore OK" || { echo "service did not come up — check journalctl" >&2; exit 1; }
```

- [ ] **Step 2: Make executable + commit**

```bash
chmod +x scripts/restore.sh
git add scripts/restore.sh
git update-index --chmod=+x scripts/restore.sh
git commit -m "feat(backup): guided restore script with JSON validation"
```

### Task 7: status.sh

**Files:**
- Create: `scripts/status.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# scripts/status.sh — one-screen health check. Exit 0 = all healthy.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/simpro-mcp}"
BK="${APP_DIR}/backups"
PORT="${SIMPRO_HTTP_PORT:-3001}"
rc=0

line() { printf '%-12s %s\n' "$1" "$2"; }

# service
if systemctl is-active --quiet simpro-mcp; then
  since="$(systemctl show simpro-mcp -p ActiveEnterTimestamp --value)"
  line "service:" "active (since ${since})"
else
  line "service:" "FAILED"; rc=1
fi

# listen
if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; then
  line "listen:" "127.0.0.1:${PORT} OK"
else
  line "listen:" "UNREACHABLE"; rc=1
fi

# funnel
if command -v tailscale >/dev/null 2>&1 && tailscale funnel status 2>/dev/null | grep -q "Funnel on"; then
  line "funnel:" "on"
else
  line "funnel:" "OFF (or tailscale unavailable)"
fi

# backups
tnewest="$(ls -1 "${BK}/tokens" 2>/dev/null | sort | tail -n1)"
line "backups:" "tokens=${tnewest:-NONE} audit=$( [ -f "${BK}/audit/audit.log.current.bak" ] && echo present || echo NONE )"
[ -z "${tnewest:-}" ] && rc=1

# timers
for t in simpro-mcp-backup-tokens.timer simpro-mcp-backup-audit.timer; do
  if systemctl is-active --quiet "${t}"; then s=ok; else s=DOWN; rc=1; fi
  line "timer:" "${t}=${s}"
done

# errors in last 24h
errs="$(journalctl -u simpro-mcp --since '24 hours ago' --no-pager 2>/dev/null | grep -cE '\[(error|fatal|srv-error)\]' || true)"
line "errors24h:" "${errs:-0}"

# systemd failed units
fc="$(systemctl --failed --no-legend 2>/dev/null | wc -l)"
line "failed:" "${fc}"
[ "${fc}" -gt 0 ] && rc=1

exit "${rc}"
```

- [ ] **Step 2: Make executable + commit**

```bash
chmod +x scripts/status.sh
git add scripts/status.sh
git update-index --chmod=+x scripts/status.sh
git commit -m "feat(ops): status.sh one-command health check"
```

---

## Phase 4 — systemd timers + installer

### Task 8: systemd units

**Files:**
- Create: `scripts/simpro-mcp-backup-tokens.service`
- Create: `scripts/simpro-mcp-backup-tokens.timer`
- Create: `scripts/simpro-mcp-backup-audit.service`
- Create: `scripts/simpro-mcp-backup-audit.timer`

- [ ] **Step 1: tokens service**

`scripts/simpro-mcp-backup-tokens.service`:

```ini
[Unit]
Description=Simpro MCP — tokens/env backup snapshot
After=simpro-mcp.service

[Service]
Type=oneshot
User=simpro-mcp
Group=simpro-mcp
WorkingDirectory=/opt/simpro-mcp
ExecStart=/bin/bash -c '/opt/simpro-mcp/scripts/backup.sh tokens && /opt/simpro-mcp/scripts/backup.sh env && /opt/simpro-mcp/scripts/backup.sh prune'
```

- [ ] **Step 2: tokens timer**

`scripts/simpro-mcp-backup-tokens.timer`:

```ini
[Unit]
Description=Simpro MCP — tokens/env backup every 15 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: audit service**

`scripts/simpro-mcp-backup-audit.service`:

```ini
[Unit]
Description=Simpro MCP — audit log daily backup + monthly archive
After=simpro-mcp.service

[Service]
Type=oneshot
User=simpro-mcp
Group=simpro-mcp
WorkingDirectory=/opt/simpro-mcp
ExecStart=/opt/simpro-mcp/scripts/backup.sh audit
```

- [ ] **Step 4: audit timer**

`scripts/simpro-mcp-backup-audit.timer`:

```ini
[Unit]
Description=Simpro MCP — audit backup daily at 00:10

[Timer]
OnCalendar=*-*-* 00:10:00
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 5: Commit**

```bash
git add scripts/simpro-mcp-backup-tokens.service scripts/simpro-mcp-backup-tokens.timer scripts/simpro-mcp-backup-audit.service scripts/simpro-mcp-backup-audit.timer
git commit -m "feat(ops): systemd timer units for backups"
```

### Task 9: installer wiring

**Files:**
- Modify: `scripts/install-on-ubuntu.sh`

- [ ] **Step 1: Read the installer to find the end-of-setup point**

Run: `grep -n "systemctl\|simpro-mcp.service\|enable" scripts/install-on-ubuntu.sh`
Expected: shows where the main service is enabled. The new block goes
just AFTER the main `systemctl enable --now simpro-mcp` line.

- [ ] **Step 2: Append the backup wiring**

After the line that does `systemctl enable --now simpro-mcp` (or
equivalent), add this block to `scripts/install-on-ubuntu.sh`:

```bash
# --- S6: backups + timers ---
install -d -o simpro-mcp -g simpro-mcp -m 700 /opt/simpro-mcp/backups
cp /opt/simpro-mcp/scripts/simpro-mcp-backup-tokens.service /etc/systemd/system/
cp /opt/simpro-mcp/scripts/simpro-mcp-backup-tokens.timer   /etc/systemd/system/
cp /opt/simpro-mcp/scripts/simpro-mcp-backup-audit.service  /etc/systemd/system/
cp /opt/simpro-mcp/scripts/simpro-mcp-backup-audit.timer    /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now simpro-mcp-backup-tokens.timer
systemctl enable --now simpro-mcp-backup-audit.timer
echo "S6 backup timers installed and enabled."
```

- [ ] **Step 3: Commit**

```bash
git add scripts/install-on-ubuntu.sh
git commit -m "feat(ops): installer creates backups dir + enables timers"
```

---

## Phase 5 — Docs

### Task 10: ADMIN.md runbook

**Files:**
- Modify: `docs/ADMIN.md`

- [ ] **Step 1: Append a Backups & Health section**

Append to the end of `docs/ADMIN.md`:

```markdown
## Backups & disaster recovery

Local backups run automatically via systemd timers:

- `tokens.json` — every 15 min, only when it changed. Newest 96 kept
  (~24h). Dir: `/opt/simpro-mcp/backups/tokens/`
- `.env` — snapshotted on change, newest 5 kept.
  Dir: `/opt/simpro-mcp/backups/env/`
- `audit.log` — `audit.log.current.bak` refreshed daily (single rolling
  copy); on the 1st of each month the previous month is archived to
  `audit-YYYY-MM.log.gz` and kept **forever**.
  Dir: `/opt/simpro-mcp/backups/audit/`

### Restore tokens.json (undo a bad edit / corruption)

```bash
ls -lt /opt/simpro-mcp/backups/tokens/         # find the snapshot you want
sudo /opt/simpro-mcp/scripts/restore.sh tokens \
     /opt/simpro-mcp/backups/tokens/tokens.json.<TS>.bak
```

The script stops the service, validates the backup is real JSON, keeps a
`tokens.json.pre-restore.<TS>` safety copy, restores, and restarts.

### Health check

```bash
sudo /opt/simpro-mcp/scripts/status.sh
```

One screen: service state, port reachability, Funnel status, newest
backups, timer health, error count in the last 24h. Exit code 0 = healthy.
**There is no push alerting** — you must run this yourself (e.g. each
morning, or when something seems off). This is a deliberate, accepted
trade-off for operational simplicity.

### Known unmitigated risk: whole-server loss

Backups are **local to the Ubuntu box**. They protect against bad edits,
corruption, and accidental deletion. They do **NOT** protect against disk
failure, theft, or total loss of the server. If the box is lost, every
coworker must re-enroll (and re-create their Simpro API key). Adding an
off-server backup tier is a separate, deferred piece of work.

## Rate limiting

Per-user MCP rate limits protect against a runaway AI tool-call loop or an
abusive user hammering Simpro's API. Two tiers (env-tunable):

| Env var | Default | Meaning |
|---|---|---|
| `SIMPRO_RATE_WINDOW_MS` | 300000 (5 min) | Sliding window |
| `SIMPRO_RATE_SOFT_LIMIT` | 120 | Over this: ONE `[warn] [rate] SOFT user=…` per user per window. Not blocked. |
| `SIMPRO_RATE_HARD_LIMIT` | 300 | Over this: request rejected with a 429-style JSON-RPC error; `[warn] [rate] HARD` logged. |

A normal chat session never approaches the soft limit. A legitimate big
batch ("update 80 jobs") may briefly cross soft (fine — warn only). Only a
stuck loop reaches hard. Grep the journal for `[rate]` during a status
review. State is in-memory and resets on service restart (acceptable — a
restart already interrupts a runaway loop).
```

- [ ] **Step 2: Commit**

```bash
git add docs/ADMIN.md
git commit -m "docs: backup/restore runbook, status.sh, rate-limit reference"
```

---

## Phase 6 — Deploy + manual verification (human, on Ubuntu)

> Not subagent work — operations on the live server. Run after all code
> phases are merged + pushed.

### Task 11: Deploy

- [ ] **Step 1: Push + pull + build**

```bash
# dev
git push

# Ubuntu
cd /opt/simpro-mcp
sudo -u simpro-mcp git pull
sudo -u simpro-mcp npm ci
sudo -u simpro-mcp npm run build
sudo systemctl restart simpro-mcp
sleep 2
sudo systemctl status simpro-mcp --no-pager | head -5
```

- [ ] **Step 2: Install backup infra**

```bash
sudo install -d -o simpro-mcp -g simpro-mcp -m 700 /opt/simpro-mcp/backups
sudo cp /opt/simpro-mcp/scripts/simpro-mcp-backup-*.service /etc/systemd/system/
sudo cp /opt/simpro-mcp/scripts/simpro-mcp-backup-*.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now simpro-mcp-backup-tokens.timer simpro-mcp-backup-audit.timer
sudo chmod +x /opt/simpro-mcp/scripts/*.sh
```

### Task 12: Manual test matrix (from the spec §Testing)

- [ ] **B1**: `sudo systemctl start simpro-mcp-backup-tokens.service` → confirm a `tokens.json.<TS>.bak` appears in `backups/tokens/`.
- [ ] **B2**: run it again immediately (no tokens change) → output `unchanged: tokens.json`, no new file.
- [ ] **B3**: hand-edit tokens.json (add a space), run the timer service → new snapshot; then `sudo scripts/restore.sh tokens <previous>` → service cycles, file restored, `restore OK`.
- [ ] **B4**: lower `prune_dir tokens` keep to 2 temporarily OR generate >96 → `backup.sh prune` removes oldest tokens; audit untouched.
- [ ] **B5**: `sudo scripts/status.sh` on healthy server → all OK, `echo $?` = 0. `sudo systemctl stop simpro-mcp` → `status.sh` shows `service: FAILED`, exit ≠ 0. Restart service.
- [ ] **B6**: change `.env` (whitespace), wait for / trigger the tokens timer → an `env.<TS>.bak` appears; no change → none.
- [ ] **B7**: `APP_DIR=/tmp/audittest` with a crafted `audit.log` containing a prior-month `"ts"` line, fake the date or invoke the archive grep manually → `audit-<prev>.log.gz` contains only that month; `audit.log.current.bak` present.
- [ ] **R1**: script-hammer `POST /mcp/plumbing` >300 times in 5 min as one user (reuse one smcp_ token) → after ceiling, 429s; a second token unaffected; `journalctl -u simpro-mcp | grep '\[rate\]'` shows SOFT then HARD.

Record pass/fail for each. Any fail → fix before closing S6.

---

## Self-review checklist

- [ ] **Spec coverage:**
  - Backups local/tiered/retention-C → Tasks 5, 8, 9 ✓
  - Audit rolling + monthly gzip (no O(n²)) → Task 5 `cmd_audit` ✓
  - Skip-if-unchanged + atomic → Task 5 `snapshot_if_changed` ✓
  - Restore wrapper → Task 6 ✓
  - `[srv-error]` / `[fatal]` logging → Task 4 steps 4–5 ✓
  - `status.sh` health screen → Task 7 ✓
  - Two-tier rate limiter + env vars → Tasks 1–4 ✓
  - ADMIN.md runbook + risk note → Task 10 ✓
  - install-on-ubuntu wiring → Task 9 ✓
- [ ] **Placeholder scan:** `<TS>`, `<prev>`, `<previous>` are command-example placeholders, not plan gaps. No "TODO"/"TBD".
- [ ] **Type consistency:** `RateLimiter({windowMs,softLimit,hardLimit})` ctor + `check()`/`sweep()`/`size()` identical across Tasks 1, 2, 4. Verdict union `"ok"|"soft"|"hard"` consistent. Config names `SIMPRO_RATE_WINDOW_MS/_SOFT_LIMIT/_HARD_LIMIT` identical in Tasks 3, 4, 10.

---

End of plan.
