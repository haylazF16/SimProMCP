# Simpro File Attachments — MCP Tools Implementation Plan (Build 1a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four generic Simpro attachment tools (list / download / upload / delete) that move real file *bytes* in and out of Simpro across all eight attachment-capable entity types, with invoice→Job auto-resolution, multi-file batches, and three upload sources.

**Architecture:** One generic toolset in a new `src/tools/attachments.ts`, parameterised by an `entityType` enum that maps to a parent resource path. A new `src/utils/files.ts` resolves an upload source (`sourceUrl` | `filePath` | `stagingRef`) to base64 bytes (with a size guard and HTML-share-link detection) and writes downloaded base64 to disk. Endpoints, config, and the `SimproClient` gain small additive helpers. Writes (`upload`/`delete`) route through the existing `writeGuard` (write-enable + `confirm` + dry-run). Reads (`list`/`download`) are ungated.

**Tech Stack:** TypeScript 5 (strict), `@modelcontextprotocol/sdk`, Zod, Vitest, undici/global `fetch`.

**Spec:** [docs/superpowers/specs/2026-06-17-simpro-file-attachments-design.md](docs/superpowers/specs/2026-06-17-simpro-file-attachments-design.md)

**Scope note:** This is **Build 1a** — the MCP tools. The drag-and-drop **portal upload page** (spec component C) that *produces* staged files is **Build 1b**, a separate follow-on plan, because it is a distinct web subsystem needing its own exploration. This plan fully implements the *consumer* side of staging (`stagingRef` reads `SIMPRO_STAGING_DIR/<ref>/<originalFilename>`), so the contract is testable today by dropping a file in that directory by hand.

---

## Staging directory contract (shared with Build 1b)

The portal page (Build 1b) and these tools agree on this on-disk layout:

```
<SIMPRO_STAGING_DIR>/
  <ref>/                 # ref = unguessable token, [A-Za-z0-9_-]{6,64}
    <originalFilename>   # exactly one regular file per ref dir
```

- The MCP reads the single non-dotfile in `<SIMPRO_STAGING_DIR>/<ref>/`, preserving the original filename.
- On a **successful** upload from a `stagingRef`, the MCP deletes the `<ref>` dir.
- Build 1b owns: creating ref dirs from dropped files, returning the ref to the user, and a 24h expiry sweep.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/config.ts` | Add `SIMPRO_MAX_ATTACHMENT_MB` (default 20) + `SIMPRO_STAGING_DIR` (default `./staging`) | Modify |
| `src/simpro/endpoints.ts` | `ATTACHMENT_ENTITY_TYPES` tuple, `ATTACHMENT_ENTITY_PATHS` map, `attachmentFiles()` / `attachmentFileById()` helpers | Modify |
| `src/simpro/client.ts` | Add `del()` HTTP verb (DELETE) | Modify |
| `src/utils/files.ts` | `pickSource`, `deriveFilename`, `guessMime`, `stagingPathForRef`, `resolveFileToBase64`, `writeBase64ToPath`, `clearStaging` | Create |
| `src/tools/attachments.ts` | `registerAttachmentTools` — the 4 tools + `resolveParentSuffix` | Create |
| `src/tools/index.ts` | Wire `registerAttachmentTools` into `registerAllTools` | Modify |
| `src/tools/notes.ts` | Delete the false "no attachment API" comment; reword the link tool | Modify |
| `tests/utils/files.test.ts` | Unit tests for `files.ts` | Create |
| `tests/simpro/endpointsAttachments.test.ts` | Path-map + helper tests | Create |
| `tests/simpro/clientDelete.test.ts` | `del()` verb test | Create |
| `tests/tools/attachments.test.ts` | Tool-level tests (list/upload/download/delete via InMemoryTransport) | Create |

---

## Task 1: Config — size guard + staging dir

**Files:**
- Modify: `src/config.ts` (inside `ConfigSchema`, after `SIMPRO_DEFAULT_PAGE_SIZE` on line 63)
- Test: `tests/_sanity.test.ts` is unrelated; add a tiny config test inline below.
- Test: `tests/config.attachments.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/config.attachments.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

const SNAPSHOT = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SNAPSHOT)) delete process.env[k];
  Object.assign(process.env, SNAPSHOT);
});

function baseEnv() {
  process.env.SIMPRO_TRANSPORT = "http";
  process.env.SIMPRO_BASE_URL = "https://x.simprosuite.com";
  process.env.SIMPRO_COMPANY_ID = "4";
}

describe("attachment config", () => {
  it("defaults SIMPRO_MAX_ATTACHMENT_MB to 20 and SIMPRO_STAGING_DIR to ./staging", () => {
    baseEnv();
    delete process.env.SIMPRO_MAX_ATTACHMENT_MB;
    delete process.env.SIMPRO_STAGING_DIR;
    const cfg = loadConfig();
    expect(cfg.SIMPRO_MAX_ATTACHMENT_MB).toBe(20);
    expect(cfg.SIMPRO_STAGING_DIR).toBe("./staging");
  });

  it("parses SIMPRO_MAX_ATTACHMENT_MB from a string env var", () => {
    baseEnv();
    process.env.SIMPRO_MAX_ATTACHMENT_MB = "50";
    expect(loadConfig().SIMPRO_MAX_ATTACHMENT_MB).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.attachments.test.ts`
Expected: FAIL — `cfg.SIMPRO_MAX_ATTACHMENT_MB` is `undefined`.

- [ ] **Step 3: Add the two fields**

In `src/config.ts`, inside `ConfigSchema`, immediately after the `SIMPRO_DEFAULT_PAGE_SIZE` line (line 63):

```ts
  // Max size (MB) for a single attachment upload or inline download. Base64
  // holds the whole file in memory and inflates ~33%, so keep this modest.
  SIMPRO_MAX_ATTACHMENT_MB: intFromString(20, 1, 200),
  // Directory the portal drag-and-drop page (Build 1b) writes staged files
  // into; the MCP reads them back by stagingRef. Relative default for dev; set
  // an absolute path on the server (e.g. /var/lib/simpro-mcp/staging).
  SIMPRO_STAGING_DIR: z.string().default("./staging"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.attachments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.attachments.test.ts
git commit -m "feat(config): add SIMPRO_MAX_ATTACHMENT_MB and SIMPRO_STAGING_DIR"
```

---

## Task 2: Endpoints — entity→path map + attachment helpers

**Files:**
- Modify: `src/simpro/endpoints.ts` (append after the `ENDPOINTS` object, after line 131)
- Test: `tests/simpro/endpointsAttachments.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/simpro/endpointsAttachments.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  ATTACHMENT_ENTITY_TYPES,
  ATTACHMENT_ENTITY_PATHS,
  attachmentFiles,
  attachmentFileById,
} from "../../src/simpro/endpoints.js";

describe("attachment endpoints", () => {
  it("maps each non-invoice entity to its parent suffix", () => {
    expect(ATTACHMENT_ENTITY_PATHS.job(132277)).toBe("/jobs/132277");
    expect(ATTACHMENT_ENTITY_PATHS.supplier(5)).toBe("/vendors/5");
    expect(ATTACHMENT_ENTITY_PATHS.purchaseOrder(9)).toBe("/vendorOrders/9");
    // Customer uses the FLAT path for attachments (not companies/individuals).
    expect(ATTACHMENT_ENTITY_PATHS.customer(7)).toBe("/customers/7");
  });

  it("includes invoice in the type list but NOT in the path map", () => {
    expect(ATTACHMENT_ENTITY_TYPES).toContain("invoice");
    expect(ATTACHMENT_ENTITY_PATHS).not.toHaveProperty("invoice");
  });

  it("builds files and file-by-id suffixes", () => {
    const parent = ATTACHMENT_ENTITY_PATHS.job(1);
    expect(attachmentFiles(parent)).toBe("/jobs/1/attachments/files/");
    expect(attachmentFileById(parent, 42)).toBe("/jobs/1/attachments/files/42");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/simpro/endpointsAttachments.test.ts`
Expected: FAIL — `ATTACHMENT_ENTITY_TYPES` is not exported.

- [ ] **Step 3: Add the map and helpers**

In `src/simpro/endpoints.ts`, append after the closing `} as const;` of `ENDPOINTS` (after line 131):

```ts

// ---- Attachments (files) — same /api/v1.0, company-scoped ----------------
// entityType -> parent resource suffix. `invoice` is intentionally ABSENT:
// invoices hold no attachments in Simpro's data model, so the attachment tools
// auto-resolve an invoice to its linked Job before building the path.
// NOTE: customer attachments use the FLAT /customers/{id} path — the typed
// companies/individuals split that the record GET needs returns 404 here.
const encId = (id: string | number) => encodeURIComponent(String(id));

export const ATTACHMENT_ENTITY_TYPES = [
  "job", "quote", "site", "supplier", "customer",
  "employee", "recurringJob", "purchaseOrder", "invoice",
] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export const ATTACHMENT_ENTITY_PATHS: Record<string, (id: string | number) => string> = {
  job: (id) => `/jobs/${encId(id)}`,
  quote: (id) => `/quotes/${encId(id)}`,
  site: (id) => `/sites/${encId(id)}`,
  supplier: (id) => `/vendors/${encId(id)}`,
  customer: (id) => `/customers/${encId(id)}`,
  employee: (id) => `/employees/${encId(id)}`,
  recurringJob: (id) => `/recurringJobs/${encId(id)}`,
  purchaseOrder: (id) => `/vendorOrders/${encId(id)}`,
};

/** List/create files under a parent resource suffix (e.g. "/jobs/1"). */
export function attachmentFiles(parentSuffix: string): string {
  return `${parentSuffix}/attachments/files/`;
}

/** A single attachment file by ID under a parent resource suffix. */
export function attachmentFileById(parentSuffix: string, fileId: string | number): string {
  return `${parentSuffix}/attachments/files/${encId(fileId)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/simpro/endpointsAttachments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/simpro/endpoints.ts tests/simpro/endpointsAttachments.test.ts
git commit -m "feat(endpoints): add attachment entity path map + file helpers"
```

---

## Task 3: Client — add `del()` verb

**Files:**
- Modify: `src/simpro/client.ts` (after the `put` method, line 58)
- Test: `tests/simpro/clientDelete.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/simpro/clientDelete.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SimproClient } from "../../src/simpro/client.js";
import type { Config } from "../../src/config.js";

const cfg = {
  SIMPRO_BASE_URL: "https://x.simprosuite.com",
  SIMPRO_API_KEY: "key12345",
  SIMPRO_COMPANY_ID: "4",
  SIMPRO_REQUEST_TIMEOUT_MS: 1000,
} as unknown as Config;

describe("SimproClient.del", () => {
  it("issues a DELETE request (non-retryable) via the core request path", async () => {
    const client = new SimproClient(cfg);
    const methods: string[] = [];
    // Shadow the private doFetch on this instance to capture the verb.
    (client as unknown as { doFetch: (m: string) => Promise<unknown> }).doFetch =
      async (m: string) => { methods.push(m); return {}; };
    await client.del("/companies/4/jobs/1/attachments/files/9");
    expect(methods).toEqual(["DELETE"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/simpro/clientDelete.test.ts`
Expected: FAIL — `client.del is not a function`.

- [ ] **Step 3: Add the `del` method**

In `src/simpro/client.ts`, immediately after the `put` method (line 58):

```ts
  del<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
```

(DELETE is not in `DEFAULT_RETRYABLE_METHODS`, so it runs exactly once — correct for a non-idempotent delete.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/simpro/clientDelete.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/simpro/client.ts tests/simpro/clientDelete.test.ts
git commit -m "feat(client): add del() DELETE verb"
```

---

## Task 4: files.ts — pure helpers (pickSource, deriveFilename, guessMime, stagingPathForRef)

**Files:**
- Create: `src/utils/files.ts`
- Test: `tests/utils/files.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/utils/files.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  pickSource,
  deriveFilename,
  guessMime,
  stagingPathForRef,
} from "../../src/utils/files.js";

describe("files.ts pure helpers", () => {
  it("pickSource returns the single populated source", () => {
    expect(pickSource({ sourceUrl: "https://e.com/a.pdf" })).toBe("sourceUrl");
    expect(pickSource({ filePath: "/tmp/a.pdf" })).toBe("filePath");
    expect(pickSource({ stagingRef: "abc123" })).toBe("stagingRef");
  });

  it("pickSource throws when zero or more-than-one source is given", () => {
    expect(() => pickSource({})).toThrow(/exactly one/i);
    expect(() => pickSource({ filePath: "/a", stagingRef: "b1c2d3" })).toThrow(/exactly one/i);
  });

  it("deriveFilename prefers explicit filename, then URL/path basename", () => {
    expect(deriveFilename({ sourceUrl: "https://e.com/x/site-photo.jpg?t=1" })).toBe("site-photo.jpg");
    expect(deriveFilename({ filePath: "/var/data/docket.pdf" })).toBe("docket.pdf");
    expect(deriveFilename({ sourceUrl: "https://e.com/a.bin", filename: "real.pdf" })).toBe("real.pdf");
  });

  it("guessMime maps known extensions and defaults to octet-stream", () => {
    expect(guessMime("a.png")).toBe("image/png");
    expect(guessMime("a.PDF")).toBe("application/pdf");
    expect(guessMime("a.unknownext")).toBe("application/octet-stream");
  });

  it("stagingPathForRef rejects path-traversal / bad tokens", () => {
    expect(() => stagingPathForRef("/staging", "../etc")).toThrow(/invalid staging ref/i);
    expect(() => stagingPathForRef("/staging", "a/b")).toThrow(/invalid staging ref/i);
    expect(stagingPathForRef("/staging", "abc123XYZ")).toContain("abc123XYZ");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/utils/files.test.ts`
Expected: FAIL — cannot find module `../../src/utils/files.js`.

- [ ] **Step 3: Create `src/utils/files.ts` with the pure helpers**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";

export interface FileSource {
  sourceUrl?: string;
  filePath?: string;
  stagingRef?: string;
  filename?: string;
}

export interface ResolvedFile {
  filename: string;
  base64: string;
  mimeType: string;
  sizeBytes: number;
}

const SOURCE_KEYS = ["sourceUrl", "filePath", "stagingRef"] as const;
type SourceKey = (typeof SOURCE_KEYS)[number];

/** Return the single populated source key, or throw if not exactly one. */
export function pickSource(file: FileSource): SourceKey {
  const set = SOURCE_KEYS.filter(
    (k) => typeof file[k] === "string" && (file[k] as string).trim() !== "",
  );
  if (set.length === 0) {
    throw new Error("Each file needs exactly one of sourceUrl, filePath or stagingRef — none were given.");
  }
  if (set.length > 1) {
    throw new Error(`Each file needs exactly one source, but got ${set.length}: ${set.join(", ")}.`);
  }
  return set[0];
}

/** Best-effort filename: explicit override wins, else the URL/path basename. */
export function deriveFilename(source: FileSource): string {
  if (source.filename && source.filename.trim()) return source.filename.trim();
  let raw = "";
  if (source.sourceUrl) {
    try {
      raw = new URL(source.sourceUrl).pathname;
    } catch {
      raw = source.sourceUrl;
    }
  } else {
    raw = source.filePath ?? source.stagingRef ?? "";
  }
  const base = path.basename(raw.split("?")[0]);
  return base || "upload.bin";
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Guess a MIME type from a filename extension. */
export function guessMime(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/** Resolve a staging ref to its directory, rejecting traversal / bad tokens. */
export function stagingPathForRef(stagingDir: string, ref: string): string {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(ref)) {
    throw new Error(`Invalid staging ref "${ref}".`);
  }
  return path.join(stagingDir, ref);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/utils/files.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/files.ts tests/utils/files.test.ts
git commit -m "feat(files): add source/filename/mime/staging-ref helpers"
```

---

## Task 5: files.ts — `resolveFileToBase64` (filePath, size guard, stagingRef, HTML detection)

**Files:**
- Modify: `src/utils/files.ts` (append `resolveFileToBase64`)
- Test: `tests/utils/files.test.ts` (append cases)

- [ ] **Step 1: Write the failing tests** — append to `tests/utils/files.test.ts`:

```ts
import { afterEach, beforeEach } from "vitest";
import * as os from "node:os";
import * as nodePath from "node:path";
import { promises as fsp } from "node:fs";
import { resolveFileToBase64 } from "../../src/utils/files.js";

describe("resolveFileToBase64", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "simpro-files-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("reads a local filePath into base64 with a guessed mime", async () => {
    const p = nodePath.join(dir, "note.txt");
    await fsp.writeFile(p, "hello");
    const r = await resolveFileToBase64({ filePath: p }, { maxBytes: 1000, stagingDir: dir });
    expect(Buffer.from(r.base64, "base64").toString()).toBe("hello");
    expect(r.filename).toBe("note.txt");
    expect(r.mimeType).toBe("text/plain");
    expect(r.sizeBytes).toBe(5);
  });

  it("rejects a file over the size guard", async () => {
    const p = nodePath.join(dir, "big.bin");
    await fsp.writeFile(p, Buffer.alloc(2048));
    await expect(
      resolveFileToBase64({ filePath: p }, { maxBytes: 1024, stagingDir: dir }),
    ).rejects.toThrow(/over the/i);
  });

  it("reads a staged file by ref from <stagingDir>/<ref>/<filename>", async () => {
    const refDir = nodePath.join(dir, "ref123ABC");
    await fsp.mkdir(refDir, { recursive: true });
    await fsp.writeFile(nodePath.join(refDir, "docket.pdf"), "PDFBYTES");
    const r = await resolveFileToBase64({ stagingRef: "ref123ABC" }, { maxBytes: 1000, stagingDir: dir });
    expect(r.filename).toBe("docket.pdf");
    expect(r.mimeType).toBe("application/pdf");
    expect(Buffer.from(r.base64, "base64").toString()).toBe("PDFBYTES");
  });

  it("errors clearly when a staging ref is missing", async () => {
    await expect(
      resolveFileToBase64({ stagingRef: "missing99" }, { maxBytes: 1000, stagingDir: dir }),
    ).rejects.toThrow(/not found or expired/i);
  });

  it("detects an HTML share page on sourceUrl and refuses it", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch;
    try {
      await expect(
        resolveFileToBase64({ sourceUrl: "https://onedrive.example/share/x" }, { maxBytes: 1000, stagingDir: dir }),
      ).rejects.toThrow(/HTML page/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("downloads bytes from a non-HTML sourceUrl", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(Buffer.from("IMG"), {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as typeof fetch;
    try {
      const r = await resolveFileToBase64(
        { sourceUrl: "https://e.com/a.png" },
        { maxBytes: 1000, stagingDir: dir },
      );
      expect(r.mimeType).toBe("image/png");
      expect(Buffer.from(r.base64, "base64").toString()).toBe("IMG");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/utils/files.test.ts`
Expected: FAIL — `resolveFileToBase64` is not exported.

- [ ] **Step 3: Append `resolveFileToBase64` to `src/utils/files.ts`**

```ts

const HTML_CONTENT_TYPE = /text\/html|application\/xhtml/i;

/**
 * Resolve exactly one upload source to base64 bytes, enforcing the size guard.
 * Throws a clear, user-facing Error on any failure (the tool layer turns these
 * into per-file results so a batch continues past one bad file).
 */
export async function resolveFileToBase64(
  source: FileSource,
  opts: { maxBytes: number; stagingDir: string },
): Promise<ResolvedFile> {
  const which = pickSource(source);
  let bytes: Buffer;
  let mimeType = "application/octet-stream";
  let filename = deriveFilename(source);

  if (which === "sourceUrl") {
    const res = await fetch(source.sourceUrl as string);
    if (!res.ok) {
      throw new Error(`Could not download sourceUrl (HTTP ${res.status}). Use a direct-download link.`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (HTML_CONTENT_TYPE.test(ct)) {
      throw new Error(
        "sourceUrl returned an HTML page, not a file. OneDrive/SharePoint 'share' links open a " +
        "viewer — use a direct-download link (e.g. one ending in ?download=1).",
      );
    }
    bytes = Buffer.from(await res.arrayBuffer());
    if (ct) mimeType = ct.split(";")[0].trim();
  } else if (which === "filePath") {
    bytes = await fs.readFile(source.filePath as string);
    mimeType = guessMime(filename);
  } else {
    const dir = stagingPathForRef(opts.stagingDir, source.stagingRef as string);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      throw new Error(`Staging ref "${source.stagingRef}" not found or expired.`);
    }
    const fileName = entries.find((e) => !e.startsWith("."));
    if (!fileName) throw new Error(`Staging ref "${source.stagingRef}" has no file.`);
    filename = source.filename?.trim() || fileName;
    bytes = await fs.readFile(path.join(dir, fileName));
    mimeType = guessMime(filename);
  }

  if (bytes.byteLength > opts.maxBytes) {
    throw new Error(
      `File "${filename}" is ${(bytes.byteLength / 1_048_576).toFixed(1)} MB, over the ` +
      `${(opts.maxBytes / 1_048_576).toFixed(0)} MB limit (SIMPRO_MAX_ATTACHMENT_MB).`,
    );
  }
  return { filename, base64: bytes.toString("base64"), mimeType, sizeBytes: bytes.byteLength };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/utils/files.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add src/utils/files.ts tests/utils/files.test.ts
git commit -m "feat(files): resolveFileToBase64 with size guard + HTML-share detection"
```

---

## Task 6: files.ts — `writeBase64ToPath` + `clearStaging`

**Files:**
- Modify: `src/utils/files.ts` (append)
- Test: `tests/utils/files.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `tests/utils/files.test.ts`:

```ts
import { writeBase64ToPath, clearStaging } from "../../src/utils/files.js";

describe("writeBase64ToPath + clearStaging", () => {
  let dir2: string;
  beforeEach(async () => {
    dir2 = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "simpro-out-"));
  });
  afterEach(async () => {
    await fsp.rm(dir2, { recursive: true, force: true });
  });

  it("writes base64 to a path, creating parent dirs, and returns the absolute path", async () => {
    const dest = nodePath.join(dir2, "nested", "out.txt");
    const abs = await writeBase64ToPath(Buffer.from("hi").toString("base64"), dest);
    expect(await fsp.readFile(abs, "utf8")).toBe("hi");
  });

  it("clearStaging removes the ref directory", async () => {
    const refDir = nodePath.join(dir2, "refToClear");
    await fsp.mkdir(refDir, { recursive: true });
    await fsp.writeFile(nodePath.join(refDir, "f.txt"), "x");
    await clearStaging(dir2, "refToClear");
    await expect(fsp.readdir(refDir)).rejects.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/utils/files.test.ts`
Expected: FAIL — `writeBase64ToPath` / `clearStaging` not exported.

- [ ] **Step 3: Append to `src/utils/files.ts`**

```ts

/** Decode base64 and write it to destPath (creating parent dirs). Returns the absolute path. */
export async function writeBase64ToPath(base64: string, destPath: string): Promise<string> {
  const abs = path.resolve(destPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(base64, "base64"));
  return abs;
}

/** Remove a staging ref directory after a successful upload. Best-effort. */
export async function clearStaging(stagingDir: string, ref: string): Promise<void> {
  const dir = stagingPathForRef(stagingDir, ref);
  await fs.rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/utils/files.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/files.ts tests/utils/files.test.ts
git commit -m "feat(files): writeBase64ToPath + clearStaging"
```

---

## Task 7: attachments.ts — `resolveParentSuffix` + `simpro_list_attachments`

**Files:**
- Create: `src/tools/attachments.ts`
- Test: `tests/tools/attachments.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/tools/attachments.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAttachmentTools } from "../../src/tools/attachments.js";
import { __resetSchemaCacheForTests, type ToolCtx } from "../../src/tools/_shared.js";

interface Spy {
  gets: { path: string; query?: unknown }[];
  posts: { path: string; payload: unknown }[];
  dels: string[];
}

function makeCtx(over: Partial<{
  get: (p: string, q?: unknown) => Promise<unknown>;
  write: boolean;
  dryRun: boolean;
}> = {}): { ctx: ToolCtx; spy: Spy } {
  const spy: Spy = { gets: [], posts: [], dels: [] };
  const ctx = {
    client: {
      companyPath: (p: string) => `/api/v1.0/companies/4${p}`,
      get: async (p: string, q?: unknown) => {
        spy.gets.push({ path: p, query: q });
        return over.get ? over.get(p, q) : [];
      },
      post: async (p: string, payload: unknown) => {
        spy.posts.push({ path: p, payload });
        return { ID: 999 };
      },
      del: async (p: string) => {
        spy.dels.push(p);
        return {};
      },
    } as unknown as ToolCtx["client"],
    config: {
      SIMPRO_ENABLE_WRITE_TOOLS: over.write ?? true,
      SIMPRO_DRY_RUN: over.dryRun ?? false,
      SIMPRO_MAX_ATTACHMENT_MB: 20,
      SIMPRO_STAGING_DIR: "./staging",
    } as unknown as ToolCtx["config"],
  };
  return { ctx, spy };
}

async function callTool(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<string> {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerAttachmentTools(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
    };
    return res.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
  } finally {
    await client.close();
    await server.close();
  }
}

describe("simpro_list_attachments", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("lists files for a job", async () => {
    const { ctx, spy } = makeCtx({
      get: async () => [{ ID: 5, Filename: "photo.jpg", MimeType: "image/jpeg" }],
    });
    const out = await callTool(ctx, "simpro_list_attachments", { entityType: "job", entityId: 132277 });
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/jobs/132277/attachments/files/");
    expect(out).toContain("#5");
    expect(out).toContain("photo.jpg");
  });

  it("auto-resolves an invoice to its linked Job", async () => {
    const { ctx, spy } = makeCtx({
      get: async (p: string) => {
        if (p.includes("/invoices/")) return { ID: 80, Jobs: { ID: 132277 } };
        return [];
      },
    });
    await callTool(ctx, "simpro_list_attachments", { entityType: "invoice", entityId: 80 });
    // Second GET must target the JOB's attachment path, not the invoice's.
    expect(spy.gets.some((g) => g.path.endsWith("/jobs/132277/attachments/files/"))).toBe(true);
  });

  it("errors when an invoice has no linked Job", async () => {
    const { ctx } = makeCtx({ get: async () => ({ ID: 80 }) });
    const out = await callTool(ctx, "simpro_list_attachments", { entityType: "invoice", entityId: 80 });
    expect(out).toMatch(/no linked Job/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/attachments.test.ts`
Expected: FAIL — cannot find module `../../src/tools/attachments.js`.

- [ ] **Step 3: Create `src/tools/attachments.ts` with the list tool**

```ts
import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ENDPOINTS,
  ATTACHMENT_ENTITY_TYPES,
  ATTACHMENT_ENTITY_PATHS,
  attachmentFiles,
  attachmentFileById,
} from "../simpro/endpoints.js";
import { idSchema, confirmSchema } from "../utils/schemas.js";
import {
  resolveFileToBase64,
  writeBase64ToPath,
  clearStaging,
  deriveFilename,
  pickSource,
} from "../utils/files.js";
import {
  ToolCtx,
  registerTool,
  safeRun,
  textResponse,
  writeGuard,
  jsonBlock,
  extractList,
  type McpTextResponse,
} from "./_shared.js";

const entityTypeSchema = z
  .enum(ATTACHMENT_ENTITY_TYPES)
  .describe(
    "Which Simpro entity holds the files. 'invoice' auto-resolves to the invoice's linked Job " +
    "(invoices cannot hold attachments directly).",
  );

/** MCP content can be text or an inline image; the shared helper type is text-only. */
type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function multiResponse(content: McpContent[], isError = false): McpTextResponse {
  return { content, isError } as unknown as McpTextResponse;
}

/**
 * Map an entityType+id to the company-scoped parent suffix for attachments.
 * `invoice` is resolved to its linked Job via a record GET (throws if none).
 */
async function resolveParentSuffix(
  ctx: ToolCtx,
  entityType: string,
  entityId: string | number,
): Promise<string> {
  if (entityType === "invoice") {
    const inv = await ctx.client.get<{ Jobs?: { ID?: number } }>(
      ctx.client.companyPath(ENDPOINTS.invoiceById(entityId)),
    );
    const jobId = inv?.Jobs?.ID;
    if (!jobId) {
      throw new Error(
        `Invoice #${entityId} has no linked Job, so it has nowhere to store attachments. ` +
        `Attach to a Job or purchase order directly.`,
      );
    }
    return ATTACHMENT_ENTITY_PATHS.job(jobId);
  }
  const builder = ATTACHMENT_ENTITY_PATHS[entityType];
  if (!builder) {
    throw new Error(`Unknown entityType "${entityType}". Valid: ${ATTACHMENT_ENTITY_TYPES.join(", ")}.`);
  }
  return builder(entityId);
}

export function registerAttachmentTools(server: McpServer, ctx: ToolCtx) {
  // ---- list attachments (read) ----
  registerTool(
    server,
    "simpro_list_attachments",
    "List files attached to a Simpro entity (job, quote, site, supplier, customer, employee, " +
      "recurringJob, purchaseOrder, or invoice → its linked Job). Read-only.",
    () => ({
      entityType: entityTypeSchema,
      entityId: idSchema,
    }),
    () => async (args) =>
      safeRun(async () => {
        const parent = await resolveParentSuffix(ctx, args.entityType, args.entityId);
        const listPath = ctx.client.companyPath(attachmentFiles(parent));
        const resp = await ctx.client.get<unknown>(listPath);
        const items = extractList(resp) as Array<Record<string, unknown>>;
        const lines = items.length
          ? items
              .map((f) => {
                const kb = typeof f.FileSizeBytes === "number" ? ` ${Math.round(f.FileSizeBytes / 1024)} KB` : "";
                const mt = f.MimeType ? ` [${f.MimeType}]` : "";
                return `- #${f.ID} ${f.Filename ?? "(unnamed)"}${mt}${kb}`;
              })
              .join("\n")
          : "(no attachments)";
        return textResponse(`Attachments on ${args.entityType} #${args.entityId}:\n${lines}`);
      }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/attachments.test.ts`
Expected: PASS (list + invoice-resolve + no-job-error cases)

- [ ] **Step 5: Commit**

```bash
git add src/tools/attachments.ts tests/tools/attachments.test.ts
git commit -m "feat(attachments): list tool + entity/invoice path resolution"
```

---

## Task 8: attachments.ts — `simpro_upload_attachment` (write, multi-file, sources)

**Files:**
- Modify: `src/tools/attachments.ts` (add the tool inside `registerAttachmentTools`)
- Test: `tests/tools/attachments.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `tests/tools/attachments.test.ts`:

```ts
import * as os from "node:os";
import * as nodePath from "node:path";
import { promises as fsp } from "node:fs";

describe("simpro_upload_attachment", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("is blocked when writes are disabled", async () => {
    const { ctx, spy } = makeCtx({ write: false });
    const out = await callTool(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ sourceUrl: "https://e.com/a.pdf" }],
    });
    expect(out).toMatch(/Write tools are disabled/i);
    expect(spy.posts).toHaveLength(0);
  });

  it("requires confirm:true (preview, no POST)", async () => {
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_upload_attachment", {
      confirm: false,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: "/tmp/whatever.pdf" }],
    });
    expect(out).toMatch(/Confirmation required/i);
    expect(spy.posts).toHaveLength(0);
  });

  it("uploads a local file and reports per-file success", async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "up-"));
    const p = nodePath.join(dir, "docket.pdf");
    await fsp.writeFile(p, "PDF");
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 132277,
      files: [{ filePath: p }],
      public: false,
    });
    expect(spy.posts[0].path).toBe("/api/v1.0/companies/4/jobs/132277/attachments/files/");
    const payload = spy.posts[0].payload as Record<string, unknown>;
    expect(payload.Filename).toBe("docket.pdf");
    expect(payload.Public).toBe(false);
    expect(Buffer.from(payload.Base64Data as string, "base64").toString()).toBe("PDF");
    expect(out).toMatch(/1 uploaded, 0 failed/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("continues a batch past one bad file (partial failure)", async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "up-"));
    const good = nodePath.join(dir, "ok.txt");
    await fsp.writeFile(good, "ok");
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_upload_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 1,
      files: [{ filePath: good }, { filePath: nodePath.join(dir, "missing.txt") }],
    });
    expect(spy.posts).toHaveLength(1); // only the good file POSTed
    expect(out).toMatch(/1 uploaded, 1 failed/);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/attachments.test.ts`
Expected: FAIL — `simpro_upload_attachment` is an unknown tool.

- [ ] **Step 3: Add the upload tool** inside `registerAttachmentTools` (after the list tool, before the closing `}`):

```ts
  // ---- upload attachment(s) (write) ----
  registerTool(
    server,
    "simpro_upload_attachment",
    "Upload one or more files into a Simpro entity (job/quote/site/supplier/customer/employee/" +
      "recurringJob/purchaseOrder, or invoice → its Job). Each file gives exactly one of sourceUrl " +
      "(server downloads it), filePath (server reads local disk), or stagingRef (a file dropped on " +
      "the internal portal). Requires confirm=true.",
    () => ({
      confirm: confirmSchema,
      entityType: entityTypeSchema,
      entityId: idSchema,
      files: z
        .array(
          z.object({
            sourceUrl: z.string().url().optional().describe("Direct-download URL the server fetches."),
            filePath: z.string().optional().describe("Path the server reads from local disk."),
            stagingRef: z.string().optional().describe("Ref of a file staged via the portal."),
            filename: z.string().optional().describe("Override the stored filename."),
          }),
        )
        .min(1)
        .describe("One entry per file; each needs exactly one source."),
      public: z.boolean().optional().describe("Visible to the customer in Simpro? Default false (internal)."),
      folderId: idSchema.optional().describe("Optional Simpro attachment folder ID to file it under."),
    }),
    () => async (args) =>
      safeRun(async () => {
        const parent = await resolveParentSuffix(ctx, args.entityType, args.entityId);
        const uploadPath = ctx.client.companyPath(attachmentFiles(parent));

        // Validate sources up front so the confirm/dry-run preview is accurate.
        const preview = args.files.map((f: Record<string, string>) => {
          const which = pickSource(f);
          return { source: which, value: f[which], filename: deriveFilename(f) };
        });
        const blocked = writeGuard(ctx, {
          confirm: args.confirm,
          method: "POST",
          path: uploadPath,
          payload: preview,
          summary: `Upload ${args.files.length} file(s) to ${args.entityType} #${args.entityId}`,
        });
        if (blocked) return blocked;

        const maxBytes = ctx.config.SIMPRO_MAX_ATTACHMENT_MB * 1_048_576;
        const results: Array<Record<string, unknown>> = [];
        for (const f of args.files) {
          try {
            const resolved = await resolveFileToBase64(f, {
              maxBytes,
              stagingDir: ctx.config.SIMPRO_STAGING_DIR,
            });
            const body: Record<string, unknown> = {
              Filename: resolved.filename,
              Base64Data: resolved.base64,
              Public: args.public ?? false,
            };
            if (args.folderId !== undefined) body.Folder = args.folderId;
            const resp = await ctx.client.post<{ ID?: number }>(uploadPath, body);
            results.push({ filename: resolved.filename, status: "created", fileId: resp?.ID });
            if (f.stagingRef) {
              await clearStaging(ctx.config.SIMPRO_STAGING_DIR, f.stagingRef).catch(() => {});
            }
          } catch (err) {
            results.push({
              filename: deriveFilename(f),
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const ok = results.filter((r) => r.status === "created").length;
        const failed = results.length - ok;
        return textResponse(
          `${ok} uploaded, ${failed} failed.\n` + jsonBlock("Results", results),
          ok === 0,
        );
      }),
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/attachments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/attachments.ts tests/tools/attachments.test.ts
git commit -m "feat(attachments): multi-file upload tool with 3 sources + write gating"
```

---

## Task 9: attachments.ts — `simpro_download_attachment` (inline image / save-to-disk / metadata)

**Files:**
- Modify: `src/tools/attachments.ts`
- Test: `tests/tools/attachments.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `tests/tools/attachments.test.ts`:

```ts
describe("simpro_download_attachment", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  function fileRecord(name: string, mime: string, text: string) {
    return { Filename: name, MimeType: mime, Base64Data: Buffer.from(text).toString("base64") };
  }

  it("requests the file with display=Base64 and returns metadata-only by default for non-images", async () => {
    const { ctx, spy } = makeCtx({ get: async () => fileRecord("report.pdf", "application/pdf", "PDF") });
    const out = await callTool(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 5 }],
    });
    expect(spy.gets[0].path).toBe("/api/v1.0/companies/4/jobs/1/attachments/files/5");
    expect(spy.gets[0].query).toEqual({ display: "Base64" });
    expect(out).toMatch(/metadata/i);
    expect(out).toContain("report.pdf");
  });

  it("returns an inline image content block for image/* files", async () => {
    const { ctx } = makeCtx({ get: async () => fileRecord("photo.png", "image/png", "PNGBYTES") });
    const out = await callTool(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 7 }],
    });
    // callTool renders an image content block as "[image]".
    expect(out).toContain("[image]");
  });

  it("writes to saveDir when given and reports the path", async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "dl-"));
    const { ctx } = makeCtx({ get: async () => fileRecord("docket.pdf", "application/pdf", "PDF") });
    const out = await callTool(ctx, "simpro_download_attachment", {
      entityType: "job",
      entityId: 1,
      files: [{ fileId: 9 }],
      saveDir: dir,
    });
    expect(out).toMatch(/saved/i);
    const written = await fsp.readFile(nodePath.join(dir, "docket.pdf"), "utf8");
    expect(written).toBe("PDF");
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/attachments.test.ts`
Expected: FAIL — `simpro_download_attachment` unknown.

- [ ] **Step 3: Add the download tool** inside `registerAttachmentTools`:

```ts
  // ---- download attachment(s) (read) ----
  registerTool(
    server,
    "simpro_download_attachment",
    "Download one or more attachments by fileId. Images render inline; pass saveDir (or per-file " +
      "savePath) to write bytes to disk; otherwise returns metadata only (use returnBase64=true to " +
      "force bytes into the response). Read-only.",
    () => ({
      entityType: entityTypeSchema,
      entityId: idSchema,
      files: z
        .array(
          z.object({
            fileId: idSchema,
            savePath: z.string().optional().describe("Write THIS file to this exact path."),
          }),
        )
        .min(1),
      saveDir: z.string().optional().describe("Write all downloaded files into this directory."),
      returnBase64: z.boolean().optional().describe("Force base64 bytes into the response, even for non-images."),
    }),
    () => async (args) =>
      safeRun(async () => {
        const parent = await resolveParentSuffix(ctx, args.entityType, args.entityId);
        const maxBytes = ctx.config.SIMPRO_MAX_ATTACHMENT_MB * 1_048_576;
        const content: McpContent[] = [];
        const results: Array<Record<string, unknown>> = [];

        for (const f of args.files) {
          try {
            const filePath = ctx.client.companyPath(attachmentFileById(parent, f.fileId));
            const rec = await ctx.client.get<{ Base64Data?: string; MimeType?: string; Filename?: string }>(
              filePath,
              { display: "Base64" },
            );
            const b64 = rec.Base64Data ?? "";
            const mime = rec.MimeType ?? "application/octet-stream";
            const name = rec.Filename ?? `file-${f.fileId}`;
            const sizeBytes = Math.floor((b64.length * 3) / 4);

            if (f.savePath || args.saveDir) {
              const dest = f.savePath ?? path.join(args.saveDir as string, name);
              const abs = await writeBase64ToPath(b64, dest);
              results.push({ fileId: f.fileId, filename: name, status: "saved", savedTo: abs });
            } else if (mime.startsWith("image/")) {
              if (sizeBytes > maxBytes) {
                results.push({
                  fileId: f.fileId,
                  filename: name,
                  status: "error",
                  error: `Image too large to inline (${(sizeBytes / 1_048_576).toFixed(1)} MB); pass saveDir.`,
                });
              } else {
                content.push({ type: "image", data: b64, mimeType: mime });
                results.push({ fileId: f.fileId, filename: name, status: "inline" });
              }
            } else if (args.returnBase64) {
              if (sizeBytes > maxBytes) {
                results.push({
                  fileId: f.fileId,
                  filename: name,
                  status: "error",
                  error: `Too large to inline (${(sizeBytes / 1_048_576).toFixed(1)} MB); pass saveDir.`,
                });
              } else {
                content.push({ type: "text", text: jsonBlock(`${name} (base64)`, { mimeType: mime, base64: b64 }) });
                results.push({ fileId: f.fileId, filename: name, status: "inline" });
              }
            } else {
              results.push({
                fileId: f.fileId,
                filename: name,
                status: "metadata",
                mimeType: mime,
                note: "Pass saveDir/savePath to download bytes, or returnBase64=true to inline.",
              });
            }
          } catch (err) {
            results.push({
              fileId: f.fileId,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const delivered = results.filter((r) => r.status === "saved" || r.status === "inline").length;
        const failed = results.filter((r) => r.status === "error").length;
        const meta = results.filter((r) => r.status === "metadata").length;
        const summary = `${delivered} delivered, ${meta} metadata-only, ${failed} failed.`;
        content.unshift({ type: "text", text: `${summary}\n${jsonBlock("Files", results)}` });
        return multiResponse(content, delivered === 0 && failed > 0);
      }),
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/attachments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/attachments.ts tests/tools/attachments.test.ts
git commit -m "feat(attachments): download tool (inline image / save-to-disk / metadata)"
```

---

## Task 10: attachments.ts — `simpro_delete_attachment` (write, multi-file)

**Files:**
- Modify: `src/tools/attachments.ts`
- Test: `tests/tools/attachments.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `tests/tools/attachments.test.ts`:

```ts
describe("simpro_delete_attachment", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("requires confirm:true (no DELETE on preview)", async () => {
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_delete_attachment", {
      confirm: false,
      entityType: "job",
      entityId: 1,
      fileIds: [5],
    });
    expect(out).toMatch(/Confirmation required/i);
    expect(spy.dels).toHaveLength(0);
  });

  it("deletes each fileId and reports the count", async () => {
    const { ctx, spy } = makeCtx();
    const out = await callTool(ctx, "simpro_delete_attachment", {
      confirm: true,
      entityType: "job",
      entityId: 132277,
      fileIds: [5, 6],
    });
    expect(spy.dels).toEqual([
      "/api/v1.0/companies/4/jobs/132277/attachments/files/5",
      "/api/v1.0/companies/4/jobs/132277/attachments/files/6",
    ]);
    expect(out).toMatch(/2 deleted, 0 failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/attachments.test.ts`
Expected: FAIL — `simpro_delete_attachment` unknown.

- [ ] **Step 3: Add the delete tool** inside `registerAttachmentTools`:

```ts
  // ---- delete attachment(s) (write) ----
  registerTool(
    server,
    "simpro_delete_attachment",
    "Delete one or more attachments by fileId from a Simpro entity. Requires confirm=true.",
    () => ({
      confirm: confirmSchema,
      entityType: entityTypeSchema,
      entityId: idSchema,
      fileIds: z.array(idSchema).min(1).describe("IDs of the attachments to delete."),
    }),
    () => async (args) =>
      safeRun(async () => {
        const parent = await resolveParentSuffix(ctx, args.entityType, args.entityId);
        const samplePath = ctx.client.companyPath(attachmentFileById(parent, args.fileIds[0]));
        const blocked = writeGuard(ctx, {
          confirm: args.confirm,
          method: "DELETE",
          path: samplePath,
          payload: { fileIds: args.fileIds },
          summary: `Delete ${args.fileIds.length} attachment(s) from ${args.entityType} #${args.entityId}`,
        });
        if (blocked) return blocked;

        const results: Array<Record<string, unknown>> = [];
        for (const id of args.fileIds) {
          try {
            await ctx.client.del(ctx.client.companyPath(attachmentFileById(parent, id)));
            results.push({ fileId: id, status: "deleted" });
          } catch (err) {
            results.push({ fileId: id, status: "error", error: err instanceof Error ? err.message : String(err) });
          }
        }
        const ok = results.filter((r) => r.status === "deleted").length;
        return textResponse(`${ok} deleted, ${results.length - ok} failed.\n` + jsonBlock("Results", results), ok === 0);
      }),
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/attachments.test.ts`
Expected: PASS (all four tools' suites green)

- [ ] **Step 5: Commit**

```bash
git add src/tools/attachments.ts tests/tools/attachments.test.ts
git commit -m "feat(attachments): multi-file delete tool with write gating"
```

---

## Task 11: Register the attachment tools in the registry

**Files:**
- Modify: `src/tools/index.ts` (add import on line ~14, add call after `registerNoteTools` on line 23)
- Test: `tests/tools/attachmentsRegistered.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/tools/attachmentsRegistered.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/tools/index.js";
import { __resetSchemaCacheForTests, type ToolCtx } from "../../src/tools/_shared.js";

describe("registerAllTools wires the attachment tools", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("exposes the four attachment tools", async () => {
    const ctx = {
      client: { companyPath: (p: string) => p, get: async () => [], post: async () => ({}), del: async () => ({}) },
      config: { SIMPRO_ENABLE_WRITE_TOOLS: false, SIMPRO_DRY_RUN: true, SIMPRO_DEFAULT_PAGE_SIZE: 25 },
    } as unknown as ToolCtx;
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    registerAllTools(server, ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("simpro_list_attachments");
      expect(names).toContain("simpro_upload_attachment");
      expect(names).toContain("simpro_download_attachment");
      expect(names).toContain("simpro_delete_attachment");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/attachmentsRegistered.test.ts`
Expected: FAIL — the four tool names are absent.

- [ ] **Step 3: Wire it in `src/tools/index.ts`**

Add the import alongside the others (after line 13, the `registerFinancialsTools` import):

```ts
import { registerAttachmentTools } from "./attachments.js";
```

Add the call inside `registerAllTools`, right after `registerNoteTools(server, ctx);` (line 23):

```ts
  registerAttachmentTools(server, ctx);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/attachmentsRegistered.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts tests/tools/attachmentsRegistered.test.ts
git commit -m "feat(tools): register attachment tools in registerAllTools"
```

---

## Task 12: Fix the false comment + reword the link tool in notes.ts

**Files:**
- Modify: `src/tools/notes.ts:40-49` (comment) and `:50-90` (tool description + note text)
- Test: `tests/tools/notesRewording.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/tools/notesRewording.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerNoteTools } from "../../src/tools/notes.js";
import { __resetSchemaCacheForTests, type ToolCtx } from "../../src/tools/_shared.js";

describe("simpro_attach_file_link_to_job description no longer claims attachments are unsupported", () => {
  beforeEach(() => __resetSchemaCacheForTests());

  it("recommends simpro_upload_attachment and drops the 'does not support' wording", async () => {
    const ctx = {
      client: { companyPath: (p: string) => p, post: async () => ({ ID: 1 }) },
      config: { SIMPRO_ENABLE_WRITE_TOOLS: false, SIMPRO_DRY_RUN: true },
    } as unknown as ToolCtx;
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    registerNoteTools(server, ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      const linkTool = tools.find((t) => t.name === "simpro_attach_file_link_to_job")!;
      expect(linkTool.description).toMatch(/simpro_upload_attachment/);
      expect(linkTool.description ?? "").not.toMatch(/doesn't support binary|does NOT support|missing attachment API/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/notesRewording.test.ts`
Expected: FAIL — current description says "Simpro's REST API doesn't support binary file uploads".

- [ ] **Step 3: Replace the comment and reword the tool**

In `src/tools/notes.ts`, **delete** the entire false comment block (lines 40-49) and replace it with:

```ts
  // ---- attach a file LINK as a job note (deliberate choice, not a workaround) ----
  // Simpro's v1.0 REST API DOES support native binary attachments — see
  // src/tools/attachments.ts (simpro_upload_attachment). This tool is the
  // alternative for cases where you'd rather keep the file in its existing
  // store (SharePoint/OneDrive/Dropbox) and just record a clickable pointer in
  // the job timeline — e.g. very large files, or links that should stay live.
```

Replace the tool **description** (line 53) with:

```ts
    "Post a link to an externally-stored file (SharePoint, OneDrive, Dropbox, etc.) as a structured job note. The file stays where it is; the job timeline shows a clearly labelled clickable note. Requires confirm=true. NOTE: for a TRUE Simpro attachment (bytes stored in Simpro), use simpro_upload_attachment instead — this link tool is for when you'd rather keep the file external (e.g. very large files).",
```

Replace the `noteText` template (lines 68-71) with:

```ts
        const noteText =
          `ATTACHMENT (link): ${args.description}\n` +
          `Link: ${args.fileUrl}\n` +
          `(Linked via Goldman Simpro AI tool — file stored externally. For a native ` +
          `Simpro attachment, simpro_upload_attachment uploads the bytes directly.)`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/notesRewording.test.ts`
Expected: PASS

- [ ] **Step 5: Update the memory note + commit**

Update `simpro-attachments-supported.md` is already accurate; no change needed. Commit:

```bash
git add src/tools/notes.ts tests/tools/notesRewording.test.ts
git commit -m "fix(notes): remove false 'no attachment API' claim; reword link tool"
```

---

## Task 13: Full build + test sweep + final commit

**Files:** none (verification)

- [ ] **Step 1: Type-check / build**

Run: `npm run build`
Expected: no TypeScript errors; `dist/` regenerated (includes `dist/tools/attachments.js`, `dist/utils/files.js`).

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all suites green, including the new `tests/utils/files.test.ts`, `tests/simpro/endpointsAttachments.test.ts`, `tests/simpro/clientDelete.test.ts`, `tests/tools/attachments.test.ts`, `tests/tools/attachmentsRegistered.test.ts`, `tests/tools/notesRewording.test.ts`, `tests/config.attachments.test.ts`.

- [ ] **Step 3: Fix any failures, then re-run** until green.

- [ ] **Step 4: Final commit (if build produced dist changes that are tracked)**

```bash
git add -A
git commit -m "chore(attachments): build dist for Simpro attachment tools (Build 1a)"
```

(If `dist/` is gitignored, skip — nothing to commit.)

---

## Manual end-to-end verification (after deploy, optional, write-enabled)

Against a real tenant with `SIMPRO_ENABLE_WRITE_TOOLS=true` and `SIMPRO_DRY_RUN=false`, on a disposable test job:

1. `simpro_list_attachments { entityType: "job", entityId: <id> }` → existing files listed.
2. `simpro_upload_attachment { confirm: true, entityType: "job", entityId: <id>, files: [{ sourceUrl: "<direct-download URL>" }] }` → `1 uploaded`.
3. `simpro_download_attachment { entityType: "job", entityId: <id>, files: [{ fileId: <new id> }], saveDir: "<tmp>" }` → file written.
4. `simpro_delete_attachment { confirm: true, entityType: "job", entityId: <id>, fileIds: [<new id>] }` → `1 deleted`.

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| 4 generic tools (list/download/upload/delete) | 7, 8, 9, 10 |
| 8 entity types via one path map | 2 |
| invoice → Job auto-resolve (+ no-Job error) | 7 |
| Multi-file batches, per-file results, summary line | 8, 9, 10 |
| Three upload sources (sourceUrl/filePath/stagingRef) | 5, 8 |
| Source mutual-exclusion validation | 4 (pickSource) |
| Size guard `SIMPRO_MAX_ATTACHMENT_MB` | 1, 5 |
| HTML-share-link detection | 5 |
| Download: inline image / save-to-disk / metadata / returnBase64 | 9 |
| Write gating via writeGuard + confirm | 8, 10 |
| Read tools ungated | 7, 9 |
| Staging read by `stagingRef` (consumer side) | 5 |
| `del()` verb (DELETE not previously supported) | 3 |
| Register in tool registry | 11 |
| Remove false comment + reword link tool | 12 |
| Build clean + tests green | 13 |
| **Portal drag-and-drop page (producer side)** | **Deferred → Build 1b** |

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — every code step shows full code. ✅

**3. Type consistency:** `resolveParentSuffix(ctx, entityType, entityId)`, `resolveFileToBase64(source, {maxBytes, stagingDir})`, `writeBase64ToPath(base64, dest)`, `clearStaging(stagingDir, ref)`, `pickSource(file)`, `deriveFilename(file)`, `attachmentFiles(parent)`, `attachmentFileById(parent, id)`, and `ctx.client.del(path)` are used identically across tasks 3–11. The `McpContent`/`multiResponse` cast is the single deliberate bridge for inline-image content (the shared `McpTextResponse` type is text-only). ✅

**Decomposition rationale:** Build 1a is independently shippable and testable — `sourceUrl`/`filePath` uploads work fully; `stagingRef` works against any file placed in `SIMPRO_STAGING_DIR/<ref>/`. Build 1b (the portal page that creates those refs) consumes only the documented staging contract and gets its own plan after a short exploration of the portal app.
