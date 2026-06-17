# Simpro File Attachments — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Branch:** `feat/http-transport`

## Problem

The MCP cannot move file *bytes* in or out of Simpro. The only existing tool,
`simpro_attach_file_link_to_job`, posts a *link* as a job note — it never
transfers the file itself. A code comment in `src/tools/notes.ts` asserted that
"Simpro v1.0 REST API does NOT expose attachments/files/documents (verified by
exhaustive endpoint sweep)." **That assertion is false** and is the root cause of
the link-only workaround.

Goldman staff need to upload supporting files (site photos, signed dockets,
supplier bills, compliance certs) into Simpro and download attachments back out,
driven from a chat client.

## Feasibility — proven live (2026-06-17)

All operations were verified against the live tenant
(`goldmanplumbingservices.simprosuite.com`, company 4) using the production API
key. **No different or newer Simpro API is required** — attachments live in the
same `/api/v1.0` REST API the MCP already uses.

Full CRUD lifecycle proven on a real job (#132277):

| Operation | Endpoint | Result |
|---|---|---|
| List files | `GET /jobs/{id}/attachments/files/` | `200`, returns `[{ID, Filename}]` |
| List folders | `GET /jobs/{id}/attachments/folders/` | `200` |
| File metadata | `GET /.../files/{fileId}` | `200`, `{Filename, MimeType, FileSizeBytes, DateAdded, AddedBy, Public}` |
| Download bytes | `GET /.../files/{fileId}?display=Base64` | `200`, `Base64Data` (2.3 MB for a 1.7 MB JPEG ≈ +33%) |
| Upload | `POST /.../files/` body `{Filename, Base64Data, Public}` | `201`, returns new file record |
| Delete | `DELETE /.../files/{fileId}` | `204`; subsequent GET → `404` |

The upload test created `MCP_TEST_DELETE_ME.png`, verified it, and deleted it —
no test data left behind.

### Attachment-capable entities (live-verified)

| Entity | Path segment | Supported |
|---|---|---|
| Jobs | `/jobs/{id}` | ✅ |
| Quotes | `/quotes/{id}` | ✅ |
| Sites | `/sites/{id}` | ✅ |
| Suppliers (vendors) | `/vendors/{id}` | ✅ |
| Customers | `/customers/{id}` | ✅ (flat path; companies/individuals split → 404) |
| Employees | `/employees/{id}` | ✅ |
| Recurring Jobs | `/recurringJobs/{id}` | ✅ |
| Purchase Orders | `/vendorOrders/{id}` | ✅ |
| Invoices / Credit notes | — | ❌ `404` on all attachment paths |

**Invoices cannot hold attachments** in Simpro's API — the invoice record has no
attachment sub-resource. This is a deliberate Simpro data-model choice: an
invoice is generated from a Job, so supporting files belong on the Job. Each
invoice record links to its Job (`"Jobs":{"ID":…}`), enabling auto-resolution
(see below).

> **Note on the customer path quirk:** `/customers/{id}` (the record itself)
> returns 404 with "Invalid resource URI" — Simpro requires
> `/customers/companies/{id}` or `/customers/individuals/{id}` for the record.
> But the *attachments* sub-resource works on the flat `/customers/{id}/attachments/...`
> path (verified `200`). The implementation uses the flat path for attachments only.

## Goals

1. Upload one or more files into any attachment-capable Simpro entity.
2. Download one or more attachments back out.
3. List and delete attachments.
4. Accept "attach to invoice X" by auto-resolving to the invoice's Job.
5. Provide a real drag-and-drop ingestion path that works through the **current**
   (paid) Claude Desktop connectors, without exposing anything new on the public
   internet.

## Non-goals (YAGNI)

- Folder management CRUD (we expose `folderId` on upload, but don't build
  folder tools).
- Invoices/credit notes as direct attachment targets (impossible — auto-resolve
  to Job instead).
- The company-wide free MCP client (separate sub-project — see Appendix).

## Approach (chosen)

**One generic attachment toolset** parameterised by `entityType`, rather than
per-entity tools. Four tools cover all eight entities through one code path;
adding a future entity is one line in a map. Rejected: per-entity tools (8 × 4 =
32 new tools, would bloat the tool list and worsen the existing two-connector
tool-name collision).

## Design

### A. Tools

All names follow the existing `simpro_<verb>_<noun>` convention.

```
simpro_list_attachments(entityType, entityId)
  → [{ID, Filename, MimeType, FileSizeBytes, DateAdded, AddedBy}]

simpro_download_attachment(entityType, entityId, files[], saveDir?, returnBase64?)
  files[]: array of fileId (+ optional per-file savePath)
  → images render inline; saveDir/savePath writes to disk; else metadata only
    (returnBase64:true forces base64 in the response)
  → per-file result: {fileId, filename, status, savedTo?|inline?|error?}

simpro_upload_attachment(entityType, entityId, files[], public?, folderId?, confirm)  [WRITE]
  files[]: array, each with exactly one of {sourceUrl | filePath | stagingRef},
           optional filename override
  → resolves each source to bytes, size-guards, POSTs {Filename, Base64Data, Public, Folder?}
  → per-file result: {filename, status: created|skipped|error, fileId?, error?}

simpro_delete_attachment(entityType, entityId, fileIds[], confirm)  [WRITE]
  → per-file result: {fileId, status: deleted|error}
```

**`entityType`** enum: `job`, `quote`, `site`, `supplier`, `customer`,
`employee`, `recurringJob`, `purchaseOrder`, plus `invoice` (auto-resolves to the
linked Job before building the attachment path; if the invoice has no linked Job,
return a clear error).

**Multi-file semantics:** every file is attempted independently; one failure
never aborts the batch. The tool returns an array of per-file results and a
summary line (`"3 uploaded, 1 failed"`).

### B. Upload sources (exactly one per file)

- **`sourceUrl`** — server fetches the bytes. Works through the current remote
  connectors. Handles OneDrive/SharePoint/web links.
- **`filePath`** — server reads from local disk. Works when the MCP can see the
  file (local STDIO mode, or a path on the Ubuntu box).
- **`stagingRef`** — a file dropped on the portal upload page (see C).

### C. Portal upload page + staging (drag-and-drop)

A drag-and-drop page served by the **internal portal (tailnet-only, port 8444)**.
Dropped files are written to a staging directory on the box; the page displays a
short **staging code**. In chat the user says *"upload my staged files to job
132277"*; the MCP reads them from the staging dir by `stagingRef`, uploads to
Simpro, and clears them on success.

- **Security:** ingestion is internal-only. Nothing new is exposed on the public
  Funnel port (443) — the public MCP never gains a file-upload endpoint. The MCP
  process and the portal share the box's local filesystem; the MCP reads the
  staging dir by path (a managed form of `filePath`).
- **Staging dir:** configurable (`SIMPRO_STAGING_DIR`, default e.g.
  `/var/lib/simpro-mcp/staging`). Files expire after 24h; a sweep removes stale
  files. Staging refs are unguessable tokens.
- **Cleanup:** on successful upload, the staged file is deleted.

### D. Download delivery

Always fetches via `?display=Base64` to get bytes + `MimeType` + `Filename`.

- **Images** (`image/*`): returned as an MCP image content block so the chat
  client renders them inline.
- **`saveDir`/`savePath` given:** decode and write to disk; return the path.
- **Otherwise:** return metadata only and instruct the caller to pass a save
  path (avoids dumping huge base64 into chat). `returnBase64: true` overrides.
- Size-guarded (see E) — oversize inline returns are refused with guidance.

### E. Safety rails

- `upload` and `delete` are **writes**: gated by `SIMPRO_ENABLE_WRITE_TOOLS` and
  require `confirm: true`, routed through the existing `writeGuard` (so
  `SIMPRO_DRY_RUN` shows the payload without sending). `list` and `download` are
  reads — no gate.
- **Size guard:** new env `SIMPRO_MAX_ATTACHMENT_MB` (default **20**), enforced
  per file before an upload POST and before an inline download. Rationale:
  Base64-in-JSON holds the whole file in memory and inflates ~33%.
- **OneDrive/SharePoint trap:** a "share" URL often returns an HTML page, not the
  file. `resolveFileToBase64` detects an HTML content-type on a `sourceUrl` fetch
  and errors with guidance to use a direct-download link.

### F. Code structure

- **New** `src/tools/attachments.ts` — registers the 4 tools (follows existing
  `registerTool` / `safeRun` / `writeGuard` / `formatRecord` patterns).
- **New** `src/utils/files.ts` —
  `resolveFileToBase64({sourceUrl|filePath|stagingRef}, maxMb)` and
  `writeBase64ToPath()`; HTML-share-link detection; filename derivation from
  URL/path.
- **New** staging module + portal upload page (internal-only). Exact wiring
  (embed in `goldmanportal/` Next.js vs. a minimal page served by the internal
  Express side) to be decided in the implementation plan; the contract is: writes
  to `SIMPRO_STAGING_DIR`, returns a staging code, MCP reads by `stagingRef`.
- **Edit** `src/simpro/endpoints.ts` — add the `entityType → path` map and
  `attachmentFiles(parentPath)` / `attachmentFileById(parentPath, fileId)`
  helpers.
- **Edit** the tool registry (where `registerNoteTools` is wired) to call
  `registerAttachmentTools`.
- **Edit** `src/tools/notes.ts` — **delete the false "no attachment API"
  comment** and reword `simpro_attach_file_link_to_job`: it is now a deliberate
  "link instead of upload" choice (useful for very large files), not a workaround
  for a missing API.
- **Edit** `src/config.ts` — add `SIMPRO_MAX_ATTACHMENT_MB` (default 20) and
  `SIMPRO_STAGING_DIR`.

### G. Error handling

- Unknown `entityType` → clear validation error listing valid types.
- `invoice` with no linked Job → explicit error ("invoice N has no linked Job;
  attach to a Job/PO directly").
- File over size guard → skipped with `error`, batch continues.
- `sourceUrl` returns HTML / non-2xx → per-file `error`, batch continues.
- `stagingRef` not found / expired → per-file `error`.
- Simpro `4xx/5xx` on a file → surfaced via existing `SimproApiError`, batch
  continues for remaining files.

### H. Testing

Unit tests under `tests/tools/` and `tests/utils/` (mock client + `fetch`, no
live writes in CI):

- `entityType → path` mapping for all eight entities + the customer flat-path
  quirk.
- `invoice → Job` auto-resolution (with-Job and no-Job cases).
- Source mutual-exclusion (zero or >1 source per file → validation error) and
  filename derivation.
- Size-guard rejection (over `SIMPRO_MAX_ATTACHMENT_MB`).
- Multi-file partial failure (one bad file, rest succeed; summary correct).
- `mime → inline` decision for download.
- HTML-share-link detection on `sourceUrl`.
- Staging read + expiry behaviour.

## Acceptance criteria

1. Staff can upload N files to any of the 8 entity types via `sourceUrl`,
   `filePath`, or `stagingRef`, gated behind write-enable + `confirm`.
2. "Attach to invoice X" lands the file on invoice X's Job.
3. Staff can list, download (inline image or to disk), and delete attachments.
4. A drag-and-drop portal page stages files that chat can then push to Simpro,
   with nothing new exposed on the public Funnel port.
5. Oversize files are refused per `SIMPRO_MAX_ATTACHMENT_MB`.
6. The false comment in `notes.ts` is removed and the link tool reworded.
7. Unit tests green; `npm run build` clean.

## Appendix — Follow-on sub-project: company-wide free client

Out of scope here, captured for the next brainstorm. Claude Desktop is the only
paid piece; the MCP server is free and client-agnostic. Recommendation:
self-host **LibreChat** (or Open WebUI) on the Ubuntu box, point it at the
existing MCP server, and back it with a local model (Hermes via Ollama) for $0
inference — falling back to a cheap API model if local tool-calling proves
unreliable. The attachment tools built here are reused unchanged by any MCP
client, including a Hermes agent (which also unlocks true local-file uploads via
`filePath`).

### Interfaces vs. components (architecture clarification)

One backend (the MCP server) is shared by every interface and is the only thing
that talks to Simpro.

```
   [Claude Desktop]  [Free web chat]  [Hermes agent]      ← clients (people type here)
          \                |                /
           \               |               /
            -------->  MCP SERVER  <-------              ← one backend, talks to Simpro
                           |
                       [Simpro API]
                           ^
        [Portal upload page] ── stages files on disk ──┘   ← helper, NOT a client
```

- **Clients (real interfaces):** (1) Claude Desktop — paid, current; (2) a free
  self-hosted web chat (LibreChat/Open WebUI) — can be powered by Hermes locally
  for $0; (3) Hermes as a standalone agent (often collapses into #2 as "LibreChat
  UI + Hermes brain"). Realistically **2–3 interfaces**, not 4.
- **Not a client:** the portal drag-and-drop upload page (component C of this
  spec). It runs no LLM and never calls Simpro — it only *stages files* that a
  client then pushes to Simpro. A loading dock, not a doorway.

### Identity / signup model (decided 2026-06-17, built with the free client)

Goldman runs on **one shared Simpro API key (Sinan Ercan's)**. Chosen model:
**shared key + open self-service name-only signup**.

- Users sign up with just their **name** — no Simpro key, no approval, instant
  access. The shared company key is used for all Simpro calls server-side.
- The **admin panel already tracks activity by name** via the audit log; this is
  reused. Tracking is **best-effort / self-declared** (the name is not verified —
  accepted trade-off for frictionless onboarding).
- **Simpro-side, every action is attributed to the shared key owner (Sinan).**
  Per-person accountability exists only in the MCP audit log.
- **Cross-client catch:** per-user tracking is natural in Claude Desktop (each
  person's OAuth signup → own token → name in audit). A shared free web client
  needs each user to map to their **own** MCP token, or it logs everyone as one
  identity — to be solved in the free-client sub-project.

This requires changing the signup/consent page from "name + Simpro key" to
"name only" and sourcing the key from server config (e.g. a shared
`SIMPRO_SHARED_API_KEY`). **Deferred to the free-client sub-project — it does not
affect this attachment build.**
