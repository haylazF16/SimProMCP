# Simpro API Gap Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce `docs/SIMPRO_API_AUDIT.md` — a single source-of-truth that enumerates every Simpro v1.0 API endpoint, marks which ones our MCP server covers, and assigns H/M/L priorities to the gaps so a future implementation cycle can fill them in batches.

**Architecture:** This is a research + documentation task, NOT a code-shipping task. No new MCP tools, no app changes. The deliverable is two committed files: a raw JSON inventory of Simpro endpoints (so the audit can be re-run later without re-scraping) and a hand-curated markdown audit. Production is mostly WebFetch + parsing + cross-referencing our existing tool list and audit-log usage patterns.

**Tech Stack:** WebFetch (to pull Simpro's public dev docs at developer.simprogroup.com/apidoc/), Node/TS for any glue (grep tooling for our tool list, JSON manipulation), markdown for the deliverable. No new runtime dependencies.

**Source spec:** `docs/superpowers/specs/2026-05-25-simpro-api-gap-audit-design.md`

**Branch:** `feat/http-transport`. No code-test gates apply (this is research); the success bar is "the audit doc is complete and the user has reviewed it".

---

## A note on TDD for this plan

Most of our plans use a TDD red→green→commit cycle. This one doesn't: there's no behavior to test, just a document to produce. Each task instead has a **verification step** confirming the output looks right (correct shape, expected counts, etc.) before moving on. The "test" is human review at the end.

---

## File map

```
docs/
├── SIMPRO_API_INVENTORY.json  (NEW) raw endpoint enumeration from Simpro's docs
└── SIMPRO_API_AUDIT.md         (NEW) the hand-curated audit narrative

(No code files. No new src/. No new tests/.)
```

Both files live at the repo root under `docs/`, sibling to the existing `docs/ADMIN.md`. They're committed to git (no secrets, no PII — just public API metadata).

---

## Task 1: Enumerate Simpro's API resource pages

**Files:**
- Create: `docs/SIMPRO_API_INVENTORY.json` (initial scaffold)

The plan: WebFetch the Simpro apidoc index, extract the list of resource pages (Jobs, Quotes, Invoices, etc.), seed an inventory JSON with one entry per resource.

- [ ] **Step 1.1: Fetch the Simpro apidoc index**

Use the WebFetch tool with:
- URL: `https://developer.simprogroup.com/apidoc/`
- Prompt: `"List every API resource (Jobs, Quotes, Invoices, Customers, etc.) that has its own documentation page in the left-nav sidebar. For each, give me: the resource name, the URL of its docs page, and a 1-sentence description of what the resource represents in Simpro. Format as a JSON array. Skip OAuth / authentication / changelog pages."`

If the response is empty or "I cannot read this page" (i.e. the docs are JS-rendered and WebFetch can't see the nav), fall back to Step 1.2. Otherwise capture the JSON output.

- [ ] **Step 1.2: Fallback — if WebFetch returned nothing useful**

Simpro's REST API v1.0 has these resource families (this list is from prior project knowledge and the existing endpoints in `src/simpro/endpoints.ts`):

```
companies, customers, sites, contacts, jobs, quotes, invoices,
purchaseOrders, suppliers, catalog (items), tasks, jobNotes,
leads, creditNotes, customerPayments, recurringJobs,
recurringInvoices, schedules, timesheets, stockTakes,
storageDevices, supplierInvoices, costCenters (setup),
staff, jobTypes, jobStatuses, quoteTypes, quoteStatuses
```

If the WebFetch fallback is needed, seed the inventory JSON with these resources and an empty `endpoints` array each — they'll be populated in Task 2.

- [ ] **Step 1.3: Write `docs/SIMPRO_API_INVENTORY.json`**

```json
{
  "generatedAt": "2026-05-25T<HH:MM>Z",
  "source": "WebFetch developer.simprogroup.com/apidoc/ (or fallback list — note which)",
  "resources": [
    {
      "name": "Jobs",
      "docsUrl": "https://developer.simprogroup.com/apidoc/jobs/",
      "description": "Service / project jobs assigned to customers and sites.",
      "endpoints": []
    },
    {
      "name": "Quotes",
      "docsUrl": "https://developer.simprogroup.com/apidoc/quotes/",
      "description": "...",
      "endpoints": []
    }
    // ... one per resource
  ]
}
```

`endpoints` arrays stay empty for now; Task 2 fills them.

- [ ] **Step 1.4: Verify**

The file should have between **15 and 30** resource entries. If fewer than 10 or more than 50, something's wrong with the parsing — investigate before proceeding.

- [ ] **Step 1.5: Commit**

```bash
git add docs/SIMPRO_API_INVENTORY.json
git commit -m "docs(audit): scaffold Simpro API resource inventory"
```

---

## Task 2: Fetch each resource page and extract endpoints

**Files:**
- Modify: `docs/SIMPRO_API_INVENTORY.json` (populate `endpoints` arrays)

For each resource from Task 1, fetch its docs page and extract the endpoint table.

- [ ] **Step 2.1: For each resource entry, WebFetch its docs page**

For every entry in `resources[]`, run:

```
WebFetch(
  url: <resource.docsUrl>,
  prompt: "List every HTTP endpoint documented on this page. For each endpoint, give me: the HTTP method (GET/POST/PATCH/DELETE), the URL path with parameter placeholders (e.g. /jobs/{jobId}/sections/{sectionId}/), and a short 1-line description of what it does. Format as JSON array with fields {method, path, description}. Skip sample request/response bodies — I only need the endpoint inventory. If this page describes Sections, Cost Centers, or other sub-resources of a parent (like a Job), list those nested sub-resource endpoints too with their full paths."
)
```

Populate `resource.endpoints` with the returned array. If a fetch fails or returns nothing useful, record `"endpoints": []` and add a `"fetchError": "<message>"` field on that resource — Task 3 will deal with these.

- [ ] **Step 2.2: Verify count**

Sum total endpoints across all resources. Expected ballpark: **80–150** (Simpro v1.0's documented surface). If you get fewer than 50 or more than 250, something's off — investigate.

Also spot-check: the **Jobs** resource alone should have at least 10 endpoints (search, get, create, update, delete, sections sub-resource, notes sub-resource, attachments sub-resource). If Jobs has fewer than 5, the parsing is missing things and you should re-fetch with a more aggressive prompt.

- [ ] **Step 2.3: Commit**

```bash
git add docs/SIMPRO_API_INVENTORY.json
git commit -m "docs(audit): populate endpoint inventory across all resources"
```

---

## Task 3: Manual gap-fill for resources where WebFetch failed

**Files:**
- Modify: `docs/SIMPRO_API_INVENTORY.json`

If any resources from Task 2 came back with empty `endpoints` and a `fetchError`, add them by hand based on prior project knowledge + the existing `src/simpro/endpoints.ts` file.

- [ ] **Step 3.1: Identify resources that need manual fill**

Open the JSON. List every resource where `endpoints.length === 0` AND `fetchError` is present.

- [ ] **Step 3.2: For each failed resource, manually enumerate**

Use this baseline set per resource (derived from common Simpro patterns + our existing endpoints constants):

Standard CRUD pattern (most resources):
- `GET /{resource}/` — search/list
- `GET /{resource}/{id}/` — get by ID
- `POST /{resource}/` — create
- `PATCH /{resource}/{id}/` — update
- `DELETE /{resource}/{id}/` — delete

Add sub-resources known from `src/simpro/endpoints.ts`:
- `GET/POST /jobs/{id}/sections/`
- `GET/POST /jobs/{id}/sections/{sid}/costCenters/`
- `GET/POST /jobs/{id}/notes/`
- `GET/POST /purchaseOrders/{id}/items/`
- (etc — match what's in our ENDPOINTS object)

Add an `"inferred": true` field on any manually-added endpoint so reviewers know it wasn't pulled from the source docs.

- [ ] **Step 3.3: Remove `fetchError` field from now-populated resources**

Clean-up — once a resource has endpoints, drop the error annotation.

- [ ] **Step 3.4: Commit**

```bash
git add docs/SIMPRO_API_INVENTORY.json
git commit -m "docs(audit): manual fill for resources WebFetch couldn't reach"
```

---

## Task 4: Enumerate our existing MCP tools and the endpoints they hit

**Files:**
- Create (temporary, in-memory or in a working note): a list of `(tool_name, endpoint_path)` pairs

The goal is a clean inventory of what we already have. No new committed file — just data that gets folded into Task 5's diff.

- [ ] **Step 4.1: Grep `src/tools/*.ts` for tool registrations**

Run:

```bash
grep -nE 'registerTool\(\s*server\s*,\s*"simpro_[a-z_]+"' src/tools/*.ts
```

Capture every tool name. Cross-reference with the audit log to confirm count (~64 tools as of `2026-05-25T12:29:22 AEST` server restart).

- [ ] **Step 4.2: For each tool, identify the endpoint(s) it hits**

For each tool, look at its body in `src/tools/<file>.ts` and find the `ENDPOINTS.<key>` reference (or the inline path string). Most tools call exactly one endpoint; some compose calls (e.g. `simpro_add_job_section` after the upgrade hits TWO endpoints — first `/jobs/{id}/sections/` then `/jobs/{id}/sections/{sid}/costCenters/`).

Look up the corresponding URL template in `src/simpro/endpoints.ts`. Normalize to the canonical form: `/jobs/{id}/sections/{id}/` (placeholder names removed — they're irrelevant for matching).

Output: a working list shaped like:

```
simpro_search_jobs        → GET /jobs/
simpro_get_job            → GET /jobs/{id}/
simpro_create_job         → POST /jobs/
simpro_update_job         → PATCH /jobs/{id}/
simpro_add_job_section    → POST /jobs/{id}/sections/
                          + POST /jobs/{id}/sections/{id}/costCenters/    (compound)
simpro_add_section_cost_centre → POST /jobs/{id}/sections/{id}/costCenters/
...
```

Keep this in a working note or scratch file (`/tmp/tools-inventory.txt`) — it's intermediate data, not committed.

- [ ] **Step 4.3: Verify**

The tool count from grep should match what the live MCP server returns (`tools/list` call):

```bash
ssh goldman-ubuntu "echo Gold@1234 | sudo -S -p '' -u simpro-mcp curl -s -N -X POST http://127.0.0.1:3001/mcp/plumbing \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer smcp_RVbocdemffvtaM1P2jgbCQYyuWhYtBCdG4m5HChGX7k' \
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}' \
  | grep -oE '\"name\":\"simpro_[a-z_]+\"' | wc -l"
```

Counts should match (64 as of latest deploy). If they don't, you're either reading stale source OR there's a tool registered programmatically that grep missed — investigate.

(No commit — Task 4's output feeds Task 5 directly.)

---

## Task 5: Diff — mark each Simpro endpoint covered or uncovered

**Files:**
- Modify: `docs/SIMPRO_API_INVENTORY.json` (add `coveredBy` field to each endpoint)

For each endpoint in the JSON, find all our tools whose normalized path matches. Record matches; flag the rest as gaps.

- [ ] **Step 5.1: Canonical-path normalization**

For both sides (Simpro endpoint paths and our tool endpoint paths):

1. Trim trailing slash.
2. Lowercase the path.
3. Replace any path parameter (`{jobId}`, `{id}`, `:jobId`, `<id>`, etc.) with the literal `{id}`.

Examples:
- `/jobs/{jobId}/sections/{sectionId}/` → `/jobs/{id}/sections/{id}`
- `/jobs/{id}/sections/{id}/costCenters/` → `/jobs/{id}/sections/{id}/costcenters`
- `/purchaseOrders/{id}` → `/purchaseorders/{id}`

Both sides go through the same function so they match exactly.

- [ ] **Step 5.2: Match each endpoint to tools**

For each endpoint in the inventory JSON:

```js
{
  method: "POST",
  path: "/jobs/{jobId}/sections/",
  description: "Create a job section",
  coveredBy: ["simpro_add_job_section"]   // ← NEW: list of tool names
}
```

If no tool matches, set `coveredBy: []`.

If a tool matches multiple endpoints (rare — e.g. a compound tool like `simpro_add_job_section`), record it on each matching endpoint.

- [ ] **Step 5.3: Verify**

Total counts in the JSON:
- Covered = endpoints where `coveredBy.length > 0`.
- Missing = endpoints where `coveredBy.length === 0`.
- Coverage % = Covered / Total * 100.

Expected ballpark from prior usage analysis: **35–55% coverage** before this audit. If you get > 80% covered, the path normalization is too loose (treating different endpoints as the same). If < 20%, normalization is too strict (missing real matches). Spot-check 5 random "missing" endpoints against the tool list to validate.

- [ ] **Step 5.4: Commit**

```bash
git add docs/SIMPRO_API_INVENTORY.json
git commit -m "docs(audit): tag every endpoint with coveredBy (tool list or empty)"
```

---

## Task 6: Assign H/M/L priorities to missing endpoints

**Files:**
- Modify: `docs/SIMPRO_API_INVENTORY.json` (add `priority` field to uncovered endpoints)

For each endpoint where `coveredBy === []`, assign H/M/L per the rubric in the spec.

- [ ] **Step 6.1: Pull the user's audit log into context for the rubric**

Get the unique list of resources the user has actively used (proxy for "they care about this"):

```bash
ssh goldman-ubuntu "echo Gold@1234 | sudo -S -p '' cat /opt/simpro-mcp/audit.log" \
  | grep -oE '"tool":"simpro_[a-z_]+"' \
  | sort | uniq -c | sort -rn
```

The resources mentioned across these tool names = the user's "active" resource set. E.g. if `simpro_get_purchase_order` is in the audit log, then **PurchaseOrders is active**. Build a list like:

```
active_resources = [Jobs, PurchaseOrders, Sites, Customers, Staff,
                    CostCenters, Suppliers, Timesheets, Quotes, Leads,
                    CustomerPayments, Invoices, Schedules, RecurringJobs]
```

(Approximate — the exact set comes from the audit log read above.)

- [ ] **Step 6.2: Identify the 4 priority workflows from the spec**

From the spec, these are the workflows the user marked as "want bulletproofed":

1. Jobs + Purchase Orders
2. Quotes → Job conversion
3. Invoicing + Payments
4. Customers / Sites / Contacts CRUD

So the **priority resources** for the rubric = Jobs, PurchaseOrders, Sections (sub-of-Jobs), CostCenters-on-sections, Quotes, Invoices, CustomerPayments, Customers, Sites, Contacts.

- [ ] **Step 6.3: Apply the rubric to each uncovered endpoint**

For each endpoint in the JSON where `coveredBy === []`, set a `priority` field by this rule:

```
let isWrite = method in {POST, PATCH, PUT, DELETE}
let isInActiveResource = endpoint.resource in active_resources
let isInPriorityWorkflow = endpoint.resource in priority_resources

if isWrite && (isInActiveResource || isInPriorityWorkflow):
  if method == DELETE:
    priority = "M"  // destructive ops are always M, even on priority resources
  else:
    priority = "H"
else if isWrite:
  priority = "M"
else if method == GET && isInActiveResource && existing tool is missing useful filters:
  priority = "M"
else:
  priority = "L"
```

The "existing tool is missing useful filters" check is judgment-based: skim the corresponding `simpro_search_*` tool's parameter list and decide whether a documented endpoint filter is missing.

- [ ] **Step 6.4: Verify the priority distribution**

Count the H/M/L distribution. Sane ballpark for a healthy audit:

- H: 5–25 (the things you'll actually want to build next)
- M: 10–40 (useful but not blocking)
- L: 30–80 (long tail, mostly safe to ignore)

If you get > 50 Highs, the rubric is too generous; tighten. If you get 0 Highs and we already know there are gaps in your priority workflows, the rubric is too strict.

- [ ] **Step 6.5: Commit**

```bash
git add docs/SIMPRO_API_INVENTORY.json
git commit -m "docs(audit): assign H/M/L priorities to all uncovered endpoints"
```

---

## Task 7: Write `docs/SIMPRO_API_AUDIT.md`

**Files:**
- Create: `docs/SIMPRO_API_AUDIT.md`

Produce the human-readable narrative + tables from the JSON.

- [ ] **Step 7.1: Compute summary statistics from the inventory JSON**

From the JSON:

- `totalEndpoints` = sum of all `endpoints.length` across resources
- `coveredEndpoints` = count where `coveredBy.length > 0`
- `coveragePct` = `coveredEndpoints / totalEndpoints * 100` (1 decimal)
- `priorityCounts` = { H: N, M: N, L: N } across all uncovered

Per-resource:
- For each resource, count its endpoints + how many are covered + coverage %
- Find the top-priority missing endpoint for each (the highest H, or first M, or first L)

- [ ] **Step 7.2: Write the markdown document**

Create `docs/SIMPRO_API_AUDIT.md` with this exact structure:

```markdown
# Simpro API gap audit

> Produced 2026-05-25 by reading `developer.simprogroup.com/apidoc/` and
> diffing against `src/tools/*.ts`. Re-run by editing
> `docs/SIMPRO_API_INVENTORY.json` (the source-of-truth raw data) and
> regenerating this markdown. The H/M/L priorities are opinionated — see
> the rubric below and feel free to adjust on review.

## Summary

- **Total endpoints documented:** <N>
- **Covered by an MCP tool:** <C> (<CC%>)
- **Missing:** <N-C>
  - High priority (writes on workflows you use): **<H>**
  - Medium (cleanup, edge cases, less-used ops): **<M>**
  - Low (rare resources, long-tail): **<L>**

### Coverage by resource (sorted, lowest coverage first)

| Resource | Endpoints | Covered | % | Top missing |
|---|---|---|---|---|
| Quotes | 16 | 4 | 25% | POST /quotes/{id}/sections/ — H |
| Invoices | 14 | 2 | 14% | POST /invoices/ — H |
| Jobs | 18 | 14 | 78% | POST /jobs/{id}/attachments/files/ — H |
| ...for every resource, sorted ascending by % | | | | |

### Priority rubric (used to assign H/M/L)

- **H** = write op (POST/PATCH/PUT) AND EITHER you've used this resource
  OR it's in your 4 priority workflows (jobs+POs, quotes, invoicing,
  customer CRUD).
- **M** = DELETE on a high-value resource, OR less-common write op
  (status transitions, file attachments), OR a GET with missing filters.
- **L** = everything else. Long tail.

---

## Jobs

> <one-line description from the JSON>

### Covered (<count>)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /jobs/ | simpro_search_jobs |
| GET | /jobs/{id}/ | simpro_get_job |
| ...one row per covered endpoint, in path order | | |

### Missing (<count>)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| DELETE | /jobs/{id}/ | Delete a job | M | Useful for cleaning up duplicate accidental creations |
| POST | /jobs/{id}/attachments/files/ | Attach file to job | H | Currently only have attach_file_link (link, not file upload) |
| ...one row per missing endpoint, sorted H→M→L then path order | | | | |

---

## Quotes

[...same shape...]

[...repeat for every resource — order resources by coverage % ascending so worst gaps are at the top...]

---

## What to do with this audit

1. **Skim the Summary section.** Anything surprise you?
2. **Edit priorities** if my rubric disagrees with what you actually need.
   This is your call — overwrite an H to L if you'll never use it, bump
   an L to H if it's secretly important.
3. **Once happy with priorities**, ask Claude to brainstorm the next
   gap-fill batch. Likely shape: one batch per priority workflow,
   in this order:
   - Jobs + POs (lowest hanging — we're already at ~80%)
   - Customers/Sites/Contacts CRUD polish
   - Quotes → Job conversion
   - Invoicing + Payments
```

- [ ] **Step 7.3: Verify the rendered markdown**

Open the file in your editor or render it (`gh markdown-preview` if you have it, or just paste a section into a markdown viewer). Check:

- Summary numbers add up (total = covered + missing; H+M+L = missing).
- Every resource section has both a Covered table and a Missing table (even if one is empty — show an "(none)" row instead of omitting).
- Tables render correctly (pipe characters not corrupted).
- No JSON placeholders like `<N>` left unfilled.

- [ ] **Step 7.4: Commit**

```bash
git add docs/SIMPRO_API_AUDIT.md
git commit -m "docs(audit): committed Simpro API gap audit report — N endpoints, CC% covered, H/M/L breakdown"
```

(Replace `N` and `CC%` with the actual numbers from the summary.)

---

## Task 8: Push and present to user for review

**Files:** none

- [ ] **Step 8.1: Push to origin**

```bash
git push origin feat/http-transport
```

- [ ] **Step 8.2: Present a summary to the user**

In your final report to the controller, give the user:

- Total endpoint count
- Coverage % overall
- Coverage % per resource (top 5 worst gaps)
- H-count (what they'd build first)
- A link to view the doc: `docs/SIMPRO_API_AUDIT.md`

Ask them to skim the doc and adjust priorities. Then the next round of brainstorming / spec / plan can begin, driven by their reviewed audit.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| Output: `docs/SIMPRO_API_AUDIT.md` with summary + per-resource tables | Task 7 |
| Output: `docs/SIMPRO_API_INVENTORY.json` (raw data, re-runnable) | Tasks 1, 2, 3, 5, 6 progressively build it |
| Source: Simpro's public dev docs at `developer.simprogroup.com/apidoc/` | Tasks 1, 2 (with Task 3 fallback for JS-rendered failures) |
| Enumerate our current tools via `src/tools/*.ts` parsing | Task 4 |
| Match by canonical path normalization | Task 5 |
| H/M/L priority rubric (write+used-or-workflow → H; deletes/edge → M; rest → L) | Task 6 |
| Acceptance: user reviews doc + confirms/edits priorities | Task 8 (handoff) |

**2. Placeholder scan:** Every step contains either real WebFetch prompts, real shell commands, real code shapes, or real document templates. The `<N>` and `<CC%>` markers in the doc template are FILL-IN markers explicitly called out in step 7.3's verification ("No JSON placeholders like `<N>` left unfilled"), so they're handled, not abandoned.

**3. Type consistency:** No code types in this plan — it's all JSON shapes and markdown. The `coveredBy: string[]` field is introduced in Task 5 and referenced consistently in Tasks 6 and 7. The `priority` field is set in Task 6 and consumed in Task 7. The `endpoints` array shape (`{method, path, description, coveredBy, priority}`) stays consistent across all tasks.

Plan is complete and self-consistent.
