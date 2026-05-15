# Reliability & monitoring (S6) — design

**Status:** Draft, ready for review
**Date:** 2026-05-12
**Author:** Tayfun + Claude (brainstorming session)

## Problem

The Goldman Simpro MCP server is moving from one user to the whole team.
Three reliability gaps exist:

1. **No backups.** `tokens.json` holds every coworker's Simpro API key +
   access grants. A bad edit, corruption, or accidental `rm` means every
   coworker must re-enroll AND re-issue their Simpro key — painful and a
   security event. `audit.log` is the compliance/forensics trail and is
   currently unprotected.
2. **Silent failures.** If the systemd service crash-loops, nobody knows
   until a coworker complains. Errors aren't surfaced in a greppable way.
3. **No per-user guardrail.** A runaway AI loop (model retrying a failing
   tool call hundreds of times) or an abusive user can hammer Simpro's API,
   risk tripping Simpro's own limits, or pollute data before anyone notices.

## Goal

Add three lightweight, single-server reliability mechanisms:

1. **Local tiered backups** of `tokens.json`, `audit.log`, `.env` with a
   tested restore procedure.
2. **Greppable crash/error logging** + an on-demand health-check script
   (no push alerting — accepted trade-off: the admin must actively check).
3. **Two-tier per-user MCP rate limiting** — warn at a soft threshold,
   hard-reject at a high ceiling, thresholds tunable via env.

## Explicitly out of scope (separate specs / accepted trade-offs)

- Off-server / cloud / disaster-recovery backups (whole-server loss is an
  accepted unmitigated risk for now).
- Push alerting (email/Telegram/webhook) — admin checks status manually.
- Cross-server HA / failover.
- Per-tool (vs per-user) rate limiting.

---

## Component 1 — Local tiered backups

### Storage location

`/opt/simpro-mcp/backups/` on the Ubuntu server, owned by the
`simpro-mcp` service account, mode `0700`. Subdirectories:

```
/opt/simpro-mcp/backups/
  tokens/   tokens.json.<ISO8601>.bak
  audit/    audit.log.<YYYY-MM-DD>.bak
  env/      env.<ISO8601>.bak
```

### Cadence

| File | Trigger | Mechanism |
|---|---|---|
| `tokens.json` | every 15 minutes | systemd timer `simpro-mcp-backup-tokens.timer` |
| `audit.log` | daily at 00:10 — see "Audit backup model" below | systemd timer `simpro-mcp-backup-audit.timer` |
| `.env` | on change (content hash differs from latest backup) | same 15-min timer as tokens, cheap hash check |

#### Audit backup model (avoids O(n²) growth)

`audit.log` is a single append-only file the app never truncates. Naïvely
copying the whole file daily and keeping every copy forever is quadratic
disk growth. Instead:

- **Rolling current copy**: `backups/audit/audit.log.current.bak` — a fresh
  full copy refreshed daily. Single file, overwritten each day. This is the
  "the live file got deleted/corrupted, give me it back" safety net.
- **Monthly compressed archives**: on the 1st of each month at 00:10, the
  daily job also writes `backups/audit/audit-<YYYY-MM>.log.gz` containing
  the entries whose timestamp falls in the *previous* month, then keeps
  these monthly gzips **forever** (this is the "keep the compliance trail
  forever" part — bounded: ~12 small gzips/year, KB-scale).
- Slicing "previous month's entries" is a `grep`/`awk` on the ISO8601 `ts`
  field each audit line already carries (audit.ts writes JSON-per-line with
  a `ts` field). No app change to the audit format needed.

Net: one rolling full copy + ~12 tiny gzips/year. Linear, tiny, and the
forever-retained artifacts are the monthly archives, not daily full copies.

systemd timers (not cron) so they share the service's environment, log to
journald, and survive reboots consistently.

### Snapshot logic (a single `scripts/backup.sh`)

```
backup.sh tokens   # copies tokens.json if it differs from the newest backup
backup.sh audit    # copies audit.log with today's date (idempotent per day)
backup.sh env      # copies .env only if sha256 != newest env backup
backup.sh prune    # applies the retention policy
```

- **Skip-if-unchanged**: `tokens` and `env` snapshots compare sha256 against
  the newest existing backup; identical content → no new file. Prevents 96
  identical copies/day when nobody enrolls.
- **Atomic**: copy to `*.tmp` then `mv` (rename is atomic on the same fs),
  so a half-written backup can never exist.
- **Read consistency**: `tokens.json` is written by the server via
  tmp-then-rename (existing behaviour), so a plain `cp` always sees a
  complete file. No locking needed.

### Retention (policy "C")

| File | Keep |
|---|---|
| `tokens.json` | newest 96 snapshots (~24h at 15-min cadence) |
| `audit.log` rolling copy | exactly 1 (`audit.log.current.bak`, overwritten daily) |
| `audit-<YYYY-MM>.log.gz` | ALL monthly archives, forever (compliance trail — never auto-pruned) |
| `.env` | newest 5 snapshots |

`backup.sh prune` runs after each tokens backup. Prune is "sort by name
(ISO timestamps sort lexically), delete all but newest N" for tokens and
env. The audit rolling copy is a single overwritten file (no prune needed).
Monthly audit gzips are never pruned by the script.

### Restore procedure (documented in `docs/ADMIN.md`)

```
# Stop the service so it doesn't overwrite during restore
sudo systemctl stop simpro-mcp

# List available snapshots
ls -lt /opt/simpro-mcp/backups/tokens/

# Restore a chosen snapshot
sudo -u simpro-mcp cp /opt/simpro-mcp/backups/tokens/tokens.json.<TS>.bak \
                      /opt/simpro-mcp/tokens.json

sudo systemctl start simpro-mcp
```

A `scripts/restore.sh <tokens|env> <snapshot-file>` wrapper performs the
stop → validate-JSON → copy → start sequence with a confirmation prompt,
so a panicked admin doesn't fat-finger the raw commands.

### Failure handling

- Backup script failure (disk full, permission) → non-zero exit → systemd
  marks the timer unit failed → visible in `systemctl --failed` and the
  health-check script (Component 2). Backups failing must not affect the
  running MCP service (separate process).

---

## Component 2 — Crash/error logging + health check

### Greppable error logging

The existing `logger.ts` already prefixes lines with `[error]` / `[warn]`.
No format change needed. Two small additions:

1. The generic Express error handler in `server.ts` already logs
   `Unhandled HTTP error: …`. Add a stable token `[srv-error]` so it can be
   grepped distinctly from tool-level errors.
2. On process-fatal events (`uncaughtException`, `unhandledRejection`), log
   `[fatal] …` to stderr before exiting so journald captures the cause
   (systemd `Restart=always` already restarts; this just records *why*).

### Health-check script

`scripts/status.sh` — run on demand by the admin. Prints, with exit code
0 = all healthy, non-zero = something wrong:

```
service:   active (running) | FAILED         (systemctl is-active)
uptime:    <since>                            (systemctl show)
listen:    127.0.0.1:3001 OK | UNREACHABLE    (curl localhost /healthz)
funnel:    on | OFF                            (tailscale funnel status)
backups:   tokens=<newest age> audit=<date>   (ls newest backup mtime)
timers:    backup-tokens=ok backup-audit=ok    (systemctl is-active *.timer)
errors24h: <count of [error]/[fatal] in journal last 24h>
failed:    <systemctl --failed count>
```

This is the "manual check" the admin runs (option D). One screen, one
command: `sudo /opt/simpro-mcp/scripts/status.sh`.

---

## Component 3 — Two-tier per-user MCP rate limiting

### Where it hooks in

`src/http/server.ts`, inside the per-request MCP handler (`handleMcp`),
AFTER `authenticate()` resolves the user but BEFORE the McpServer handles
the request. We already have `auth.record.name` / the smcp_ token there.

### Algorithm

In-memory sliding-window counter keyed by smcp_ token:

```
windowMs        = SIMPRO_RATE_WINDOW_MS        (default 300_000 = 5 min)
softLimit       = SIMPRO_RATE_SOFT_LIMIT       (default 120)
hardLimit       = SIMPRO_RATE_HARD_LIMIT       (default 300)
```

Per request:
1. Append `now` to the user's timestamp array; drop entries older than
   `windowMs`.
2. `count = array.length`.
3. If `count > hardLimit` → respond 429 JSON-RPC error
   `{code:-32004, message:"Rate limit exceeded — wait a few minutes"}`,
   do NOT process the tool call. Log `[warn] rate: HARD user=<name>
   count=<n> window=<ms>`.
4. Else if `count > softLimit` and we haven't already warned this user
   in this window → log `[warn] rate: SOFT user=<name> count=<n>`.
   (One warn per user per window — avoid log spam.)
5. Else proceed normally.

In-memory is acceptable: the server is single-process; on restart the
window resets (fine — a restart already interrupted any runaway loop).
No persistence, no Redis.

### Why these defaults

- 120 calls / 5 min soft = ~1 call every 2.5s sustained. A human chatting
  with Claude never approaches this; a legitimate batch ("update 80 jobs")
  might briefly. Warn-only, never blocks.
- 300 calls / 5 min hard = pathological. Only a stuck retry loop or abuse
  produces this. Reject is correct here.
- All three are env vars (trusted config) so they're tunable without a
  code change after observing real traffic.

### Memory bound

The timestamp map is keyed by active smcp_ token. Entries are pruned
opportunistically (old timestamps dropped on each request). A token with
no traffic for `windowMs` leaves an empty array; a periodic sweep (every
`windowMs`) deletes empty-array keys so the map can't grow unbounded from
churned/revoked tokens. Bounded by active-user count (~dozens) — trivial.

---

## File / change map

```
NEW:
  scripts/backup.sh                       – tokens|audit|env|prune subcommands
  scripts/restore.sh                      – guided restore wrapper
  scripts/status.sh                       – on-demand health check
  scripts/simpro-mcp-backup-tokens.timer  – systemd timer (15 min)
  scripts/simpro-mcp-backup-tokens.service
  scripts/simpro-mcp-backup-audit.timer   – systemd timer (daily 00:10)
  scripts/simpro-mcp-backup-audit.service
  src/http/rateLimit.ts                   – per-user sliding-window limiter
  tests/http/rateLimit.test.ts            – unit tests for the limiter

MODIFIED:
  src/http/server.ts        – call the rate limiter in handleMcp;
                              tag generic error handler [srv-error];
                              add uncaughtException/unhandledRejection [fatal] logging
  src/config.ts             – SIMPRO_RATE_WINDOW_MS / _SOFT_LIMIT / _HARD_LIMIT
                              zod-validated env vars with defaults
  .env.example              – document the 3 new rate-limit vars
  docs/ADMIN.md             – backup/restore runbook + status.sh usage
  scripts/install-on-ubuntu.sh – install + enable the two backup timers,
                              create backups/ dir with correct perms
```

The rate limiter is its own file (`rateLimit.ts`) with one clear job —
pure function + small state, independently unit-testable, no HTTP/Express
coupling in its core logic (server.ts adapts the result to a JSON-RPC
response).

## Testing

**Automated (vitest):**
- `rateLimit.test.ts`: under soft → allowed no warn; crossing soft → one
  warn, still allowed; crossing hard → blocked; window expiry resets
  count; one-warn-per-window dedup; empty-key sweep removes idle tokens.

**Manual (documented in spec, run on Ubuntu):**
- B1: trigger 15-min tokens timer manually
  (`systemctl start simpro-mcp-backup-tokens.service`), confirm a
  timestamped file appears in `backups/tokens/`.
- B2: run it again immediately with no tokens.json change → no new file
  (skip-if-unchanged works).
- B3: hand-edit tokens.json, run backup, confirm new snapshot; run
  `restore.sh tokens <prev>` → service stops, file restored, service
  starts, dashboard shows pre-edit state.
- B4: let prune run with >96 token snapshots (or lower the limit via a
  test) → oldest token snapshots pruned, audit rolling copy + monthly
  gzips untouched.
- B7: simulate a month boundary (or invoke the monthly archive step
  directly) → `audit-<prev-month>.log.gz` created containing only that
  month's lines; rolling `audit.log.current.bak` still present.
- B5: `status.sh` on a healthy server → all green, exit 0; stop the
  service → `status.sh` shows FAILED, exit non-zero.
- B6: env change → next 15-min tick produces an env snapshot; no change →
  none.
- R1: hammer `/mcp/plumbing` with a script >300 times in 5 min as one
  user → 429s after the ceiling; a second user is unaffected; journal
  shows SOFT then HARD warn lines.

## Rollout

1. Build, push, deploy via existing flow (`git pull && npm ci &&
   npm run build && systemctl restart`).
2. `install-on-ubuntu.sh` re-run (or a documented manual snippet) to
   create `backups/`, install + `systemctl enable --now` the two timers.
3. Verify B1/B5 manually.
4. Set `SIMPRO_RATE_*` in `.env` only if defaults need tuning (they
   shouldn't initially).
5. Update `docs/ADMIN.md` with the restore runbook; brief Sinan.

## Risks / notes

- **Disk growth from audit archives kept forever**: bounded to ~12
  gzipped monthly files per year (KB-scale each). Linear, not quadratic —
  the daily full copy is a single overwritten file. Decades before disk
  is a concern. Documented in ADMIN.md.
- **In-memory rate state lost on restart**: acceptable — a restart already
  interrupts a runaway loop; legitimate users aren't penalised by a reset.
- **No off-server backup**: explicitly accepted. Whole-server loss → team
  re-onboards. Flagged in ADMIN.md as the one unmitigated DR gap so it's a
  conscious, documented risk, not a surprise.
- **Manual health check only**: if the admin doesn't run `status.sh`, a
  crash-loop is still silent. Accepted per option-D decision; `status.sh`
  is designed to be a single memorable command to lower that friction.
