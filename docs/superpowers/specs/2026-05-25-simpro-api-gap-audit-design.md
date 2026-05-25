# Simpro API gap audit — design

> Status: design approved (2026-05-25). Next: implementation plan to produce the audit doc.

## Why

We've grown to 64 tools by reactive additions — every time Claude can't do
something, we add a tool. This causes two problems:

1. **Friction in the user's workflow.** Each gap → "missing tool" error →
   add a tool → reconnect connector → retry. Repeated mid-session.
2. **Blind spots.** We don't know what we don't have. Some operations the
   user has never tried because Claude implicitly knows they'd fail.

The goal of THIS work isn't to build more tools yet — it's to produce a
**single source of truth** that enumerates every Simpro API endpoint, marks
which ones we cover, scores the gaps, and becomes the input for a future
batch of focused implementation work (jobs+POs, quotes, invoices,
customer/site polish).

The user explicitly chose "spec-driven audit first" over the alternative
of just shipping more tools workflow-by-workflow. The audit is the
deliverable; the implementation backlog flows from it.

## Scope

**In:**

- Enumerate Simpro v1.0 REST API endpoints (publicly documented at
  `developer.simprogroup.com/apidoc/`).
- Match each endpoint to an existing MCP tool (by URL-path pattern).
- Categorize gaps by resource type and assign H/M/L priority.
- Output a single markdown file: `docs/SIMPRO_API_AUDIT.md`.

**Out:**

- Building any new tools (that's a follow-up cycle, post-review).
- Covering Simpro's deprecated v0.x API or any unreleased v2.x endpoints.
- OAuth-flow endpoints (those are server-internal, not user-facing tool
  surface).
- Per-tenant custom endpoints (some Simpro builds expose tenant-specific
  routes; we cover only the standard public docs).

## Output format

`docs/SIMPRO_API_AUDIT.md` will have this exact structure:

```markdown
# Simpro API gap audit

> Produced YYYY-MM-DD by reading developer.simprogroup.com/apidoc/ and
> diffing against src/tools/*.ts. Re-run this when Simpro publishes new
> endpoints or we add new tools — the script in
> scripts/audit-simpro-coverage.ts (if we keep it) regenerates the data
> tables; the narrative + priorities are hand-curated.

## Summary

- Total endpoints documented: **N**
- Covered by an MCP tool: **C (CC%)**
- Missing: **N-C**
  - High priority (workflows you use daily): **H**
  - Medium (cleanup, edge cases, less-used ops): **M**
  - Low (rare resources, deprecated features): **L**

Coverage by resource (top-10 by endpoint count):
| Resource | Endpoints | Covered | % | Top gap |
|---|---|---|---|---|
| Jobs | 18 | 14 | 78% | DELETE /jobs/{id}/sections/{sid}/ |
| Quotes | 16 | 4 | 25% | POST /quotes/{id}/sections/, sections+items unknown |
| ... | | | | |

## Jobs

### Covered (14)
| Endpoint | Tool |
|---|---|
| GET /jobs/ | simpro_search_jobs |
| GET /jobs/{id}/ | simpro_get_job |
| ... | |

### Missing (4)
| Endpoint | Method | Description | Priority | Notes |
|---|---|---|---|---|
| /jobs/{id}/attachments/files/ | POST | Attach file to job | H | covers ~30 calls/wk in audit; currently only have attach_file_link |
| /jobs/{id}/sections/{sid}/costCenters/{ccid}/ | DELETE | Remove cost-centre line | M | needed for cleanup of mis-added cost centres |
| /jobs/{id}/ | DELETE | Delete a job | M | useful for cleaning up duplicate accidental creations |
| ... | | | | |

## Quotes
[...same shape...]

[...repeat for every resource...]
```

## Production method

### Step 1 — Enumerate Simpro endpoints

`developer.simprogroup.com/apidoc/` is the public reference. Each resource
(Jobs, Quotes, etc.) has its own page that lists endpoints with HTTP
methods, URLs, and short descriptions. The process:

1. WebFetch the apidoc index page → extract the list of resource pages
   (sidebar nav links).
2. For each resource page, WebFetch and extract the endpoint table.
   Capture: HTTP method, path, short description.
3. Persist the raw enumeration into `docs/SIMPRO_API_INVENTORY.json` so
   we can rebuild the audit without re-fetching every time. (Useful when
   the audit becomes stale: just re-run the diff against an updated
   tool list.)

Fallback when the docs page is hard to parse: fill in manually from the
user-facing docs URL printed in each page header. We're producing an
audit, not generating tools from the spec — minor inaccuracies in
descriptions don't block the work.

### Step 2 — Enumerate our current tools

Small script `scripts/audit-simpro-coverage.ts` (or a one-shot grep — we
don't need this to be reusable yet) that walks `src/tools/*.ts`, finds
every `registerTool("simpro_xxx", ...)` call, and captures:

- Tool name
- Description (from the second arg of registerTool)
- Endpoint(s) it hits (look up via the ENDPOINTS constant — most tools
  reference one of `ENDPOINTS.xxx`)

### Step 3 — Match by URL-path pattern

Normalize both sides into a canonical pattern with placeholder names
removed: `/jobs/123/sections/456/` → `/jobs/{id}/sections/{id}/`. Both
our tool's endpoint template and Simpro's documented endpoint go through
the same normalization, then match by exact string. Where multiple tools
cover one endpoint (e.g. a search-with-filters vs a list-by-id), record
all of them in the Covered column.

### Step 4 — Hand-curate priorities

Mechanical match produces the coverage status; priorities are judgment
calls. Apply this rubric:

- **H** if it's a write/create/update AND EITHER (a) the resource
  appears in your audit log (you actually use it) OR (b) it's part of
  one of the four workflows you marked priority (jobs+POs, quotes,
  invoicing, customer CRUD). The OR means: a write op on a workflow
  you've never tried is still High because you said you want that
  workflow bulletproofed.
- **M** if it's a delete/destructive/cleanup operation on a resource
  that appears in your audit log or priority workflows, OR a less-common
  write op (status transitions, file attachments, etc.), OR a read
  operation on a frequently-used resource where the existing read tool
  is missing a useful filter/option.
- **L** otherwise — reads on resources you've never touched (stocktakes,
  storage devices, plant equipment, contractor mgmt, etc.) and any
  operation on resources entirely outside the four picked workflows
  AND your existing audit history.

The priority column is the operator-actionable signal. The user can
edit it after review.

### Step 5 — Commit

Single PR adds:

- `docs/SIMPRO_API_AUDIT.md` (the audit narrative)
- `docs/SIMPRO_API_INVENTORY.json` (raw endpoint data, easier to re-diff
  later)
- Optionally `scripts/audit-simpro-coverage.ts` if the matching/diff
  logic is non-trivial enough to keep.

## What happens after this

After the audit is committed and the user reviews it:

1. **User reviews and adjusts priorities.** They edit the H/M/L column
   based on knowledge we don't have (e.g. "we never use credit notes,
   downgrade to L").
2. **Brainstorm the gap-fill cycle.** New brainstorm round, this time
   driven by the H-priority gaps from the audit.
3. **Spec → plan → implement** the gap-fill batches. Likely still
   workflow-by-workflow, but now we know we're not missing anything.
4. **Repeat for M/L items as needed** — most won't be needed.

The audit itself becomes a living doc — re-runnable when Simpro releases
new endpoints or we add new tools.

## Risks / open questions

- **Simpro docs may be JavaScript-rendered.** WebFetch returns HTML
  after a basic render but doesn't execute JS. If the apidoc page
  requires JS to populate the endpoint tables, we'll need to fall back
  to other sources (Postman collection, OpenAPI spec download, manual
  enumeration). I'll know within the first fetch whether this is an
  issue and adjust.
- **The "raw inventory JSON" step might be overkill.** If the audit
  takes 2 hours and is rarely re-run, we could skip the JSON
  intermediate and write the markdown directly. The plan should keep
  it optional.
- **Priority assignment is opinionated.** Two reasonable people would
  disagree on the H/M/L cut. The user has explicit final say — the
  audit table is editable; they can rebalance.

## Acceptance criteria

The audit is "done" when:

1. Every Simpro v1.0 endpoint listed in the public docs appears in one
   of the per-resource sections.
2. Every existing `simpro_*` tool is mapped to one or more endpoints.
3. The summary section shows total counts + coverage % by resource.
4. The user has reviewed the doc and confirmed (or edited) the H/M/L
   priorities.
5. The committed `docs/SIMPRO_API_AUDIT.md` becomes the input to the
   next brainstorming cycle.
