# Speed + Smartness fixes — implementation plan

> Execute via subagent-driven-development. Steps use checkbox syntax.

**Goal:** Fix the two production complaints — tools are slow, and Claude
can't find the info asked for — via 6 targeted fixes identified by the
diagnostic review.

**Decisions locked:**
- #6 customer/status/date filtering uses **option A** (client-side filter
  over a larger fetched page, with a documented page-limit caveat).

**Tech stack:** Node 18+, TypeScript ESM strict, vitest. Existing suite:
61 tests passing. No regressions allowed.

---

## Task A — Keep-alive HTTP agent + lower timeout

**Files:** Modify `src/simpro/client.ts`, `src/config.ts`.

- [ ] **A1** In `src/config.ts`, change the default for
  `SIMPRO_REQUEST_TIMEOUT_MS` from `30_000` to `12_000`. Keep min/max
  bounds as-is. Only the default literal changes.

- [ ] **A2** In `src/simpro/client.ts`: add a module-level keep-alive
  agent and pass it to every `fetch`. Node 18 ships undici; use
  `import { Agent } from "undici";` and a module-scope
  `const keepAliveAgent = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 16 });`
  Pass `dispatcher: keepAliveAgent` in the `fetch(url, { ... })` options
  object in the core request method. Do NOT change retry/timeout logic
  otherwise.

- [ ] **A3** `npm run typecheck && npm run build && npm test` — all clean,
  61 pass.

- [ ] **A4** Commit:
  `git add src/simpro/client.ts src/config.ts && git commit -m "perf(client): keep-alive connection reuse; 12s default timeout"`

Note for implementer: if `import { Agent } from "undici"` is not resolvable
(undici not a declared dep), STOP and report — do not add a new dependency
without escalating; fallback is `import { Agent } from "node:https"` with
`new https.Agent({ keepAlive: true, maxSockets: 16 })` passed as `agent`
(not `dispatcher`) — but Node's global `fetch` ignores the `agent` option,
so undici's `dispatcher` is required. If undici is unavailable, report
BLOCKED with that finding.

---

## Task B — Strip HTML Description from default output

**Files:** Modify the shared response shaper (likely `src/tools/_shared.ts`
— grep for `export function formatRecord`). Modify `src/utils/sanitise.ts`
if a strip helper belongs there. Add tests.

- [ ] **B1** Add a `stripHtml(s: string): string` helper in
  `src/utils/sanitise.ts`: remove tags (`/<[^>]+>/g` → ""), decode the
  common entities (`&amp; &lt; &gt; &quot; &#39; &nbsp;`), collapse
  whitespace, trim. Export it.

- [ ] **B2** Write `tests/utils/sanitise.test.ts` (or extend if exists)
  covering: tags removed, entities decoded, whitespace collapsed, plain
  text passes through unchanged, empty/undefined-safe.

- [ ] **B3** In `formatRecord` (and any get_* response builder that dumps
  a full record), before serializing: for any string field whose name
  matches `/description|notes?|details/i` AND whose length > 200 AND which
  contains `<`, replace its value with `stripHtml(value)` truncated to 500
  chars + `" …[truncated; pass raw=true for full]"`. Only when the tool
  was NOT called with `raw=true`. Tools already accept a `raw`/`rawPayload`
  concept — confirm the existing flag name; if a read tool has no `raw`
  param, add an optional `raw: z.boolean().optional()` to the search/get
  tool input schemas that currently dump big records (jobs, quotes,
  invoices, customers, suppliers, purchase_orders) and thread it into
  formatRecord. Keep the change minimal and consistent.

- [ ] **B4** typecheck + build + test. New sanitise tests pass; suite
  green (≥ 61 + new).

- [ ] **B5** Commit:
  `git add -A && git commit -m "perf(output): strip HTML description blobs unless raw=true"`

---

## Task C — Sparse `columns=` on search GETs

**Files:** Modify search tools that list records:
`src/tools/jobs.ts`, `quotes.ts`, `invoices.ts`, `customers.ts`,
`suppliers.ts`, and any other `search_*` that returns lists. Inspect
`src/simpro/endpoints.ts` / `client.ts` for how query params are passed.

- [ ] **C1** For each `search_*` list call, add a `columns` query param
  with a resource-appropriate allowlist of useful fields. Suggested sets
  (adjust to actual Simpro column names found in the code/endpoints —
  verify against existing working tools, do NOT invent column names):
  - jobs: `ID,Name,Customer,Site,Status,Total,DateIssued`
  - quotes: `ID,Name,Customer,Site,Stage,Status,Total,DateIssued`
  - invoices: `ID,Customer,Status,Total,DateIssued`
  - customers: `ID,CompanyName,GivenName,FamilyName,Email,Phone`
  - suppliers: `ID,Name,Email,Phone`
  If you cannot confirm a column name exists for a resource, OMIT that
  column rather than risk a Simpro 400 — fewer columns is still a win.
  If adding `columns` causes any existing test to fail, the test encodes
  expected behaviour: investigate, don't blindly delete it; report as a
  concern if genuinely ambiguous.

- [ ] **C2** typecheck + build + test, all green.

- [ ] **C3** Commit:
  `git add -A && git commit -m "perf(search): request sparse columns from Simpro list endpoints"`

---

## Task D — Client-side customer/status/date filtering (the smartness fix)

**Files:** `src/tools/jobs.ts`, `quotes.ts`, `invoices.ts`. Possibly a
shared helper in `src/utils/`. Add tests.

Context: these tools currently pass `CustomerID`/`SiteID`/`Status`/
`DateIssuedFrom`/`DateIssuedTo` as Simpro query params. Simpro v1.0 list
endpoints silently ignore unknown filter columns, so these never apply —
"jobs for customer X" returns the unfiltered first page. Fix with
**option A**: fetch a larger page, filter in our code.

- [ ] **D1** Add a shared helper (e.g. in `src/utils/listFilter.ts`):
  `applyClientFilters(rows, { customerId?, siteId?, status?, dateFrom?, dateTo? })`
  that filters an array of Simpro list rows by:
  - `customerId`: row's customer id (handle both `row.Customer?.ID` and a
    flat `row.CustomerID` shape — inspect a real tool's response handling
    to get the actual shape; the diagnostic noted suppliers/financials use
    dotted `Customer.ID` so the nested object shape is likely)
  - `siteId`: similar nested `row.Site?.ID`
  - `status`: case-insensitive match on the row's status label/name
  - `dateFrom`/`dateTo`: inclusive ISO date range on the issue-date field
  Pure function, no I/O. Unknown/missing filters are no-ops.

- [ ] **D2** Write `tests/utils/listFilter.test.ts`: each filter alone,
  combined filters, no-filter passthrough, nested vs flat id shapes,
  date-range edges (inclusive), case-insensitive status.

- [ ] **D3** In `search_jobs`/`search_quotes`/`search_invoices`: STOP
  passing the bogus filter params to Simpro. Instead: fetch with
  `pageSize = min(SIMPRO_MAX_PAGE_SIZE, 250)` (clamp to the configured
  max), then `applyClientFilters(...)` on the returned rows, then apply
  the user's requested result limit. When the fetched page hit the cap
  AND filters were supplied, append a note to the response:
  `"(showing matches within the first N records; narrow your query if a
  match seems missing)"`.

- [ ] **D4** Update each tool's DESCRIPTION string to accurately state it
  filters by customer/site/status/date (now true). Fix any description
  that overclaims (the diagnostic flagged `search_customers` description
  claiming email/phone search that the code didn't do — if you touch a
  description, make it match real behaviour).

- [ ] **D5** typecheck + build + test, all green (61 + new).

- [ ] **D6** Commit:
  `git add -A && git commit -m "fix(search): client-side customer/status/date filtering (Simpro ignores list filters)"`

---

## Task E — Cache McpServer per (company, writeEnabled)

**Files:** `src/http/server.ts`. The riskiest change — it's the hot path.
Do it LAST so prior fixes are already stable.

Context: `handleMcp` constructs a fresh `SimproClient` AND `McpServer`
(+ `registerAllTools`, ~50 zod schemas) on every JSON-RPC POST. Cache the
McpServer; keep SimproClient per-request (it carries per-user
key/company/writeEnabled and must not leak between users).

- [ ] **E1** Read `handleMcp` and `registerAllTools` carefully. Determine
  how tools obtain their `SimproClient` (constructor capture vs a ctx
  object). The McpServer can only be safely cached if the per-request
  client is injected at call-time, not captured at register-time.

- [ ] **E2** Implement a module-level
  `Map<string, McpServer>` keyed by `${company}:${writeEnabled}`. On
  request: build/lookup the cached server; provide the per-request
  `SimproClient` via a request-scoped mechanism the tool handlers read
  (AsyncLocalStorage, or a mutable ctx the server closes over that is set
  per request BEFORE dispatch and is concurrency-safe). **Critical
  safety:** under concurrent requests from two different users hitting the
  same cache key, request A's tools must NEVER use request B's
  SimproClient (cross-tenant data leak). If a safe injection point isn't
  cleanly achievable without a larger refactor, IMPLEMENT
  AsyncLocalStorage (Node built-in, request-scoped, concurrency-safe) —
  do not ship a shared-mutable-ctx race.

- [ ] **E3** If you determine the safe change is materially larger than a
  cache + ALS wrapper (e.g. tools deeply capture the client), STOP and
  report DONE_WITH_CONCERNS describing the refactor surface — do not
  half-implement a racy cache.

- [ ] **E4** Add a focused test
  `tests/http/serverCache.test.ts` (supertest): two sequential requests
  with the SAME (company,writeEnabled) reuse one McpServer instance
  (assert via a spy/counter on registerAllTools or server construction);
  two DIFFERENT keys get different servers; and a test that two
  interleaved requests with different per-user clients do not cross
  (assert each response reflects its own user's client — mock the client).

- [ ] **E5** typecheck + build + test, all green.

- [ ] **E6** Commit:
  `git add -A && git commit -m "perf(server): cache McpServer per (company,writeEnabled); per-request client via AsyncLocalStorage"`

---

## Final

- [ ] Cross-cutting review of the whole range.
- [ ] Manual deploy + smoke on Ubuntu (human): pull, npm ci, build,
  restart; verify a "find jobs for customer <real name>" query now
  returns correctly filtered results and feels faster.

## Notes / risks

- Task E is the only Medium-risk item; the concurrency-safety gate (E2/E3)
  is explicit — a racy cache is worse than no cache. AsyncLocalStorage is
  the safe default.
- Task D changes result semantics (client-side, page-bounded). The
  appended caveat note keeps it honest.
- No new runtime dependencies except undici, which ships with Node 18+
  (Task A escalates if not resolvable).
