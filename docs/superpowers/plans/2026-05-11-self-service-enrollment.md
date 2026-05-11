# Self-service enrollment + admin dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual `add-user.sh` onboarding with a web form where coworkers paste only their Simpro API key — the server validates against Simpro, auto-detects company access, and completes the OAuth flow — and add an admin dashboard so Tayfun can view, revoke, toggle write access, and manually create users without SSHing to Ubuntu.

**Architecture:** New `/enroll/probe` AJAX endpoint and rewritten `/authorize/consent` accept a Simpro API key, live-validate against Simpro's `/info` and per-company endpoints to detect access, and either return an existing user's `smcp_` token (idempotent re-enrollment) or create a new one. The `smcp_` token is never shown to the user. An `/admin` dashboard guarded by an `isAdmin` flag on the admin's `tokens.json` record exposes view/revoke/toggle-write/audit/manual-create actions. All endpoints reuse the existing `express-rate-limit` already wired in. Manual smoke tests T1–T9 from the design doc cover the integration flow.

**Tech Stack:** Node.js 18+, TypeScript (ESM, strict), Express 4, @modelcontextprotocol/sdk, zod, express-rate-limit (already added). New dev deps: vitest, supertest.

**Source spec:** `docs/superpowers/specs/2026-05-11-self-service-enrollment-design.md`

---

## File structure

### Files to create

| Path | Responsibility |
|---|---|
| `src/http/enroll.ts` | Orchestrator: `enrollUser(simproApiKey, name)` ties verifyApiKey + probeCompany + tokens.ts together. Also `unenrollUser(simproApiKey)` and `probeForFrontend(simproApiKey)`. No HTTP, pure functions. |
| `src/http/admin.ts` | Admin router: `requireAdmin` middleware + route handlers for the dashboard. Uses tokens.ts + enroll.ts. |
| `src/http/admin-templates.ts` | HTML template strings for admin pages (`renderDashboard`, `renderAuditView`, `renderManualCreatePage`, `renderManualCreateResult`). Kept separate so admin.ts is logic-only. |
| `src/http/unenroll.ts` | Unenroll router: GET form, POST handler. Small file, two functions. |
| `src/simpro/probe.ts` | New low-level helpers: `verifyApiKey(baseUrl, key)` and `probeCompany(baseUrl, key, companyId)`. Used by enroll.ts. Doesn't depend on SimproClient (which expects a full Config — we don't have one before enrollment). |
| `docs/ADMIN.md` | How the admin dashboard works, how to grant admin to others. |
| `tests/simpro/probe.test.ts` | Unit tests for verifyApiKey + probeCompany. |
| `tests/http/enroll.test.ts` | Unit tests for enrollUser + unenrollUser + probeForFrontend. |
| `tests/http/admin.test.ts` | Unit tests for requireAdmin middleware. |
| `tests/http/tokens.test.ts` | Unit tests for new tokens.ts helpers (lookupBySimproKey, addUser, removeUser, updateUser). |
| `vitest.config.ts` | Vitest configuration (TypeScript + ESM). |

### Files to modify

| Path | Change |
|---|---|
| `src/http/tokens.ts` | Extend `TokenRecord` schema with `enrolledVia` and `isAdmin`. Add `lookupBySimproKey(file, key)`, `addUser(file, record)`, `removeUser(file, smcpToken)`, `updateUser(file, smcpToken, patch)`. Promise-chain serialized writes (already added in earlier audit; reuse). |
| `src/http/oauth.ts` | Rewrite consent page HTML to ask for Simpro key. Rewrite POST `/authorize/consent` to call `enrollUser`. Add GET `/enroll/probe` AJAX handler. Remove old "paste smcp_ token" flow. |
| `src/http/server.ts` | Mount admin router and unenroll router. Add rate limiters for the new endpoints. |
| `package.json` | Add vitest + supertest as devDependencies. Add `"test"` and `"test:watch"` scripts. |
| `docs/COWORKER-CONNECT.md` | Simplify per the new flow (drop step 2 = "send IT your Simpro key"; coworker now just pastes it on the page). |

---

## Phase 0 — Test framework setup

### Task 1: Install vitest + supertest

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dev deps**

Run:
```bash
npm install --save-dev vitest@^2.1.0 supertest@^7.0.0 @types/supertest@^6.0.0
```

Expected: 3 packages added to `devDependencies` in `package.json`.

- [ ] **Step 2: Add test scripts to package.json**

Modify `package.json`, in the `"scripts"` object add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Final `"scripts"` block should be:

```json
"scripts": {
  "build": "tsc",
  "start": "node dist/index.js",
  "dev": "tsx src/index.ts",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Verify the framework loads**

Run: `npx vitest --version`
Expected: prints a version number (e.g. `2.1.x`).

### Task 2: Add a stub test to verify the runner works end-to-end

**Files:**
- Create: `tests/_sanity.test.ts`

- [ ] **Step 1: Write the stub test**

```typescript
// tests/_sanity.test.ts
import { describe, it, expect } from "vitest";

describe("vitest sanity check", () => {
  it("can run a TypeScript test", () => {
    const x: number = 1 + 1;
    expect(x).toBe(2);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test`
Expected: 1 test passes, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json tests/_sanity.test.ts
git commit -m "test: add vitest test framework"
```

---

## Phase 1 — Low-level Simpro probe helpers

### Task 3: Write tests for verifyApiKey

**Files:**
- Create: `tests/simpro/probe.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/simpro/probe.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { verifyApiKey, probeCompany } from "../../src/simpro/probe.js";

const BASE = "https://test.simprosuite.com";

// Mock global fetch
let originalFetch: typeof globalThis.fetch;
let lastRequest: { url: string; init: RequestInit } | null = null;
let mockResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastRequest = null;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    lastRequest = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify(mockResponse.body), {
      status: mockResponse.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("verifyApiKey", () => {
  it("returns {valid:true,name} when /info returns 200 with employee data", async () => {
    mockResponse = { status: 200, body: { EmployeeName: "Tayfun Isik" } };
    const result = await verifyApiKey(BASE, "abc123");
    expect(result.valid).toBe(true);
    expect(result.name).toBe("Tayfun Isik");
  });

  it("returns {valid:true,name:null} when /info returns 200 but no employee name", async () => {
    mockResponse = { status: 200, body: {} };
    const result = await verifyApiKey(BASE, "abc123");
    expect(result.valid).toBe(true);
    expect(result.name).toBeNull();
  });

  it("returns {valid:false,reason:'invalid_key'} on 401", async () => {
    mockResponse = { status: 401, body: { error: "unauthorized" } };
    const result = await verifyApiKey(BASE, "abc123");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_key");
  });

  it("returns {valid:false,reason:'invalid_key'} on 403", async () => {
    mockResponse = { status: 403, body: {} };
    const result = await verifyApiKey(BASE, "abc123");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_key");
  });

  it("returns {valid:false,reason:'simpro_unreachable'} on network error", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const result = await verifyApiKey(BASE, "abc123");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("simpro_unreachable");
  });

  it("sends Authorization: Bearer header with the key", async () => {
    mockResponse = { status: 200, body: {} };
    await verifyApiKey(BASE, "my-secret-key");
    const auth = (lastRequest!.init.headers as Record<string, string>)["Authorization"];
    expect(auth).toBe("Bearer my-secret-key");
  });

  it("calls the correct URL", async () => {
    mockResponse = { status: 200, body: {} };
    await verifyApiKey(BASE, "abc");
    expect(lastRequest!.url).toBe("https://test.simprosuite.com/api/v1.0/info/");
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test`
Expected: tests fail because `../../src/simpro/probe.js` doesn't exist yet.

### Task 4: Implement verifyApiKey

**Files:**
- Create: `src/simpro/probe.ts`

- [ ] **Step 1: Write the minimal implementation**

```typescript
// src/simpro/probe.ts
// Low-level Simpro REST probes used during enrollment.
// These exist as standalone functions (not on SimproClient) because we call
// them BEFORE the caller has a verified API key — there's no Config to bind
// a SimproClient to yet.

export interface VerifyResult {
  valid: boolean;
  /** Employee name if Simpro returned one. */
  name: string | null;
  /** Set when valid=false. */
  reason?: "invalid_key" | "simpro_unreachable" | "unexpected_status";
}

/**
 * Probe Simpro's /info endpoint with the candidate API key to verify the key
 * is real and (best-effort) extract the linked employee's name.
 *
 * Returns valid=true on 2xx. Treats 401/403 as invalid_key. Network errors map
 * to simpro_unreachable so the UI can show "try again."
 */
export async function verifyApiKey(baseUrl: string, apiKey: string): Promise<VerifyResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1.0/info/`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
    });
  } catch {
    return { valid: false, name: null, reason: "simpro_unreachable" };
  }

  if (res.status === 401 || res.status === 403) {
    return { valid: false, name: null, reason: "invalid_key" };
  }
  if (res.status < 200 || res.status >= 300) {
    return { valid: false, name: null, reason: "unexpected_status" };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Body wasn't JSON — Simpro returned 200 but garbage. Treat as valid
    // (the key works) but no name extracted.
    return { valid: true, name: null };
  }

  return { valid: true, name: extractEmployeeName(body) };
}

/**
 * Best-effort extraction of an employee name from /info response.
 * Simpro tenants vary; we look at the common shapes. Returns null if none match.
 */
function extractEmployeeName(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  // Common shapes Simpro has returned over different API versions:
  //   { EmployeeName: "Tayfun Isik" }
  //   { Employee: { GivenName, FamilyName } }
  //   { LinkedEmployee: { Name: "..." } }
  if (typeof b.EmployeeName === "string" && b.EmployeeName.trim()) return b.EmployeeName.trim();
  const emp = b.Employee as Record<string, unknown> | undefined;
  if (emp) {
    const given = typeof emp.GivenName === "string" ? emp.GivenName : "";
    const family = typeof emp.FamilyName === "string" ? emp.FamilyName : "";
    const combined = `${given} ${family}`.trim();
    if (combined) return combined;
  }
  const linked = b.LinkedEmployee as Record<string, unknown> | undefined;
  if (linked && typeof linked.Name === "string" && linked.Name.trim()) return linked.Name.trim();
  return null;
}

export interface ProbeCompanyResult {
  granted: boolean;
}

/** Stub — implemented in Task 6. */
export async function probeCompany(_baseUrl: string, _apiKey: string, _companyId: string): Promise<ProbeCompanyResult> {
  throw new Error("not implemented yet");
}
```

- [ ] **Step 2: Run tests to confirm they pass**

Run: `npm test -- tests/simpro/probe.test.ts`
Expected: 7 tests pass.

### Task 5: Write tests for probeCompany

**Files:**
- Modify: `tests/simpro/probe.test.ts`

- [ ] **Step 1: Append the failing tests**

Append at the end of `tests/simpro/probe.test.ts`:

```typescript
describe("probeCompany", () => {
  it("returns granted:true when company endpoint returns 200", async () => {
    mockResponse = { status: 200, body: [] };
    const result = await probeCompany(BASE, "key", "4");
    expect(result.granted).toBe(true);
  });

  it("returns granted:false on 403", async () => {
    mockResponse = { status: 403, body: {} };
    const result = await probeCompany(BASE, "key", "4");
    expect(result.granted).toBe(false);
  });

  it("returns granted:false on 404", async () => {
    mockResponse = { status: 404, body: {} };
    const result = await probeCompany(BASE, "key", "37");
    expect(result.granted).toBe(false);
  });

  it("returns granted:false on network error (treats as no access)", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const result = await probeCompany(BASE, "key", "4");
    expect(result.granted).toBe(false);
  });

  it("calls the correct URL with company id and pageSize=1", async () => {
    mockResponse = { status: 200, body: [] };
    await probeCompany(BASE, "key", "37");
    expect(lastRequest!.url).toBe("https://test.simprosuite.com/api/v1.0/companies/37/jobs/?pageSize=1");
  });
});
```

- [ ] **Step 2: Run tests to confirm probeCompany ones fail**

Run: `npm test -- tests/simpro/probe.test.ts`
Expected: 5 new tests fail (function throws "not implemented yet").

### Task 6: Implement probeCompany

**Files:**
- Modify: `src/simpro/probe.ts`

- [ ] **Step 1: Replace the stub**

Replace the stub `probeCompany` function with:

```typescript
/**
 * Probe a company-scoped endpoint to verify the API key has access to it.
 * We hit /jobs/?pageSize=1 because it's documented, cheap, and exists for
 * every company tenant. 2xx = granted; anything else (incl. network error)
 * = not granted.
 */
export async function probeCompany(baseUrl: string, apiKey: string, companyId: string): Promise<ProbeCompanyResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1.0/companies/${encodeURIComponent(companyId)}/jobs/?pageSize=1`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
    });
  } catch {
    return { granted: false };
  }
  return { granted: res.status >= 200 && res.status < 300 };
}
```

- [ ] **Step 2: Run tests to confirm they pass**

Run: `npm test -- tests/simpro/probe.test.ts`
Expected: 12 tests pass (7 existing + 5 new).

### Task 7: Commit Phase 1

- [ ] **Step 1: Commit**

```bash
git add src/simpro/probe.ts tests/simpro/probe.test.ts
git commit -m "feat(simpro): add verifyApiKey + probeCompany helpers"
```

---

## Phase 2 — Extend tokens.ts schema and add CRUD helpers

### Task 8: Write tests for extended TokenRecord schema

**Files:**
- Create: `tests/http/tokens.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/http/tokens.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadTokens, saveTokens, addUser, removeUser, updateUser, lookupBySimproKey } from "../../src/http/tokens.js";

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `tokens-test-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

describe("loadTokens schema", () => {
  it("accepts a record with enrolledVia field", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_test1": {
          name: "Tayfun",
          simproApiKey: "key12345",
          companyAccess: ["plumbing"],
          enrolledVia: "self-service",
        },
      },
    }));
    const data = loadTokens(tmpFile);
    expect(data.tokens["smcp_test1"].enrolledVia).toBe("self-service");
  });

  it("accepts a record with isAdmin:true field", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_test1": {
          name: "Tayfun",
          simproApiKey: "key12345",
          companyAccess: ["plumbing"],
          isAdmin: true,
        },
      },
    }));
    const data = loadTokens(tmpFile);
    expect(data.tokens["smcp_test1"].isAdmin).toBe(true);
  });

  it("defaults isAdmin to false when missing", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_test1": {
          name: "Tayfun",
          simproApiKey: "key12345",
          companyAccess: ["plumbing"],
        },
      },
    }));
    const data = loadTokens(tmpFile);
    expect(data.tokens["smcp_test1"].isAdmin).toBe(false);
  });

  it("rejects invalid enrolledVia value", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_test1": {
          name: "Tayfun",
          simproApiKey: "key12345",
          companyAccess: ["plumbing"],
          enrolledVia: "magic-portal",
        },
      },
    }));
    expect(() => loadTokens(tmpFile)).toThrow(/enrolledVia/);
  });
});

describe("lookupBySimproKey", () => {
  it("returns the smcp token + record matching the given Simpro key", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_abc": { name: "A", simproApiKey: "key-a", companyAccess: ["plumbing"] },
        "smcp_xyz": { name: "B", simproApiKey: "key-b", companyAccess: ["energy"] },
      },
    }));
    const found = lookupBySimproKey(tmpFile, "key-b");
    expect(found).not.toBeNull();
    expect(found!.smcpToken).toBe("smcp_xyz");
    expect(found!.record.name).toBe("B");
  });

  it("returns null when no record matches", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    expect(lookupBySimproKey(tmpFile, "nonexistent")).toBeNull();
  });
});

describe("addUser", () => {
  it("creates a new record and returns the generated smcp token", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    const result = addUser(tmpFile, {
      name: "Jane",
      simproApiKey: "key-jane",
      companyAccess: ["plumbing", "energy"],
      writeEnabled: true,
      enrolledVia: "self-service",
    });
    expect(result.smcpToken).toMatch(/^smcp_[A-Za-z0-9_-]{20,}$/);
    const after = loadTokens(tmpFile);
    expect(after.tokens[result.smcpToken].name).toBe("Jane");
    expect(after.tokens[result.smcpToken].enrolledVia).toBe("self-service");
    expect(after.tokens[result.smcpToken].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("removeUser", () => {
  it("deletes the record for the given smcp token", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_keep": { name: "Keep", simproApiKey: "k1", companyAccess: ["plumbing"] },
        "smcp_drop": { name: "Drop", simproApiKey: "k2", companyAccess: ["plumbing"] },
      },
    }));
    const removed = removeUser(tmpFile, "smcp_drop");
    expect(removed).toBe(true);
    const after = loadTokens(tmpFile);
    expect(after.tokens["smcp_drop"]).toBeUndefined();
    expect(after.tokens["smcp_keep"]).toBeDefined();
  });

  it("returns false when the token doesn't exist", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    expect(removeUser(tmpFile, "smcp_nonexistent")).toBe(false);
  });
});

describe("updateUser", () => {
  it("merges the patch into the existing record", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_one": {
          name: "User",
          simproApiKey: "k1",
          companyAccess: ["plumbing"],
          writeEnabled: false,
        },
      },
    }));
    const updated = updateUser(tmpFile, "smcp_one", { writeEnabled: true });
    expect(updated).toBe(true);
    const after = loadTokens(tmpFile);
    expect(after.tokens["smcp_one"].writeEnabled).toBe(true);
    expect(after.tokens["smcp_one"].name).toBe("User");
  });

  it("returns false when the token doesn't exist", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    expect(updateUser(tmpFile, "smcp_nope", { writeEnabled: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- tests/http/tokens.test.ts`
Expected: tests fail — `addUser`, `removeUser`, `updateUser`, `lookupBySimproKey` aren't exported yet; the schema doesn't accept `enrolledVia` or `isAdmin`.

### Task 9: Extend the TokenRecord schema + validator

**Files:**
- Modify: `src/http/tokens.ts`

- [ ] **Step 1: Update the TokenRecord interface**

In `src/http/tokens.ts`, replace the `TokenRecord` interface with:

```typescript
export interface TokenRecord {
  name: string;
  simproApiKey: string;
  companyAccess: CompanyKey[];
  writeEnabled?: boolean;
  createdAt?: string;
  lastUsedAt?: string;
  /** Provenance hint; defaults to "add-user.sh" when absent (back-compat). */
  enrolledVia?: "self-service" | "manual" | "add-user.sh";
  /** Admin flag for dashboard access. Defaults false when absent. */
  isAdmin?: boolean;
}
```

- [ ] **Step 2: Update validateRecord to accept and validate the new fields**

In `src/http/tokens.ts`, find the `validateRecord` function and replace its return statement with this expanded version:

```typescript
function validateRecord(token: string, rec: unknown): TokenRecord {
  if (!rec || typeof rec !== "object") {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... is not an object`);
  }
  const r = rec as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name.length === 0) {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... missing "name"`);
  }
  if (typeof r.simproApiKey !== "string" || r.simproApiKey.length < 8) {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... missing/short "simproApiKey"`);
  }
  if (!Array.isArray(r.companyAccess) || r.companyAccess.length === 0) {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... "companyAccess" must be a non-empty array`);
  }
  for (const c of r.companyAccess) {
    if (typeof c !== "string" || !VALID_COMPANY_KEYS.has(c as CompanyKey)) {
      throw new Error(`tokens.json: record for ${token.slice(0, 8)}... has invalid companyAccess value: ${JSON.stringify(c)}`);
    }
  }
  // New: enrolledVia is optional but must be one of the known values if present.
  if (r.enrolledVia !== undefined &&
      r.enrolledVia !== "self-service" &&
      r.enrolledVia !== "manual" &&
      r.enrolledVia !== "add-user.sh") {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... has invalid enrolledVia: ${JSON.stringify(r.enrolledVia)}`);
  }
  // New: isAdmin is optional, must be boolean if present.
  if (r.isAdmin !== undefined && typeof r.isAdmin !== "boolean") {
    throw new Error(`tokens.json: record for ${token.slice(0, 8)}... has non-boolean isAdmin: ${JSON.stringify(r.isAdmin)}`);
  }
  return {
    name: r.name,
    simproApiKey: r.simproApiKey,
    companyAccess: r.companyAccess as CompanyKey[],
    writeEnabled: r.writeEnabled === true,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined,
    lastUsedAt: typeof r.lastUsedAt === "string" ? r.lastUsedAt : undefined,
    enrolledVia: r.enrolledVia as TokenRecord["enrolledVia"],
    isAdmin: r.isAdmin === true,
  };
}
```

- [ ] **Step 3: Run schema tests to confirm they pass**

Run: `npm test -- tests/http/tokens.test.ts -t "loadTokens schema"`
Expected: 4 schema tests pass.

### Task 10: Implement lookupBySimproKey

**Files:**
- Modify: `src/http/tokens.ts`

- [ ] **Step 1: Add the export**

At the end of `src/http/tokens.ts`, add:

```typescript
/**
 * Find a user record by their Simpro API key (the long-term identity).
 * Used for idempotent re-enrollment. Linear scan — fine at Goldman scale (<50 users).
 */
export function lookupBySimproKey(
  filePath: string,
  simproApiKey: string,
): { smcpToken: string; record: TokenRecord } | null {
  const store = loadTokens(filePath);
  for (const [smcpToken, record] of Object.entries(store.tokens)) {
    if (record.simproApiKey === simproApiKey) {
      return { smcpToken, record };
    }
  }
  return null;
}
```

- [ ] **Step 2: Run the related tests**

Run: `npm test -- tests/http/tokens.test.ts -t "lookupBySimproKey"`
Expected: 2 tests pass.

### Task 11: Implement addUser

**Files:**
- Modify: `src/http/tokens.ts`

- [ ] **Step 1: Add the export**

At the end of `src/http/tokens.ts`, add:

```typescript
/**
 * Insert a new record. Generates a fresh smcp_ token and returns it.
 * Caller is responsible for checking idempotency (call lookupBySimproKey first).
 */
export function addUser(
  filePath: string,
  partial: Omit<TokenRecord, "createdAt" | "lastUsedAt">,
): { smcpToken: string; record: TokenRecord } {
  const smcpToken = generateToken();
  const record: TokenRecord = {
    ...partial,
    createdAt: new Date().toISOString(),
  };
  // Bypass the mtime cache so we read the latest disk state before mutating.
  cache = null;
  const store = loadTokens(filePath);
  store.tokens[smcpToken] = record;
  saveTokens(filePath, store);
  return { smcpToken, record };
}
```

- [ ] **Step 2: Run the addUser test**

Run: `npm test -- tests/http/tokens.test.ts -t "addUser"`
Expected: 1 test passes.

### Task 12: Implement removeUser

**Files:**
- Modify: `src/http/tokens.ts`

- [ ] **Step 1: Add the export**

At the end of `src/http/tokens.ts`, add:

```typescript
/**
 * Delete a record by smcp_ token. Returns true if it existed and was removed.
 */
export function removeUser(filePath: string, smcpToken: string): boolean {
  cache = null;
  const store = loadTokens(filePath);
  if (!(smcpToken in store.tokens)) return false;
  delete store.tokens[smcpToken];
  saveTokens(filePath, store);
  return true;
}
```

- [ ] **Step 2: Run the removeUser tests**

Run: `npm test -- tests/http/tokens.test.ts -t "removeUser"`
Expected: 2 tests pass.

### Task 13: Implement updateUser

**Files:**
- Modify: `src/http/tokens.ts`

- [ ] **Step 1: Add the export**

At the end of `src/http/tokens.ts`, add:

```typescript
/**
 * Merge a partial patch into an existing record. Returns true if the record
 * exists. Used by the admin dashboard for "toggle write access" etc.
 */
export function updateUser(
  filePath: string,
  smcpToken: string,
  patch: Partial<Omit<TokenRecord, "simproApiKey" | "createdAt">>,
): boolean {
  cache = null;
  const store = loadTokens(filePath);
  if (!(smcpToken in store.tokens)) return false;
  store.tokens[smcpToken] = { ...store.tokens[smcpToken], ...patch };
  saveTokens(filePath, store);
  return true;
}
```

- [ ] **Step 2: Run the updateUser tests**

Run: `npm test -- tests/http/tokens.test.ts -t "updateUser"`
Expected: 2 tests pass.

### Task 14: Verify full tokens.test.ts suite passes

- [ ] **Step 1: Run full file**

Run: `npm test -- tests/http/tokens.test.ts`
Expected: 11 tests pass.

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit code 0.

### Task 15: Commit Phase 2

- [ ] **Step 1: Commit**

```bash
git add src/http/tokens.ts tests/http/tokens.test.ts
git commit -m "feat(tokens): extend schema with enrolledVia + isAdmin; add CRUD helpers"
```

---

## Phase 3 — Enrollment orchestrator

### Task 16: Write tests for enrollUser

**Files:**
- Create: `tests/http/enroll.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/http/enroll.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enrollUser, unenrollUser, probeForFrontend } from "../../src/http/enroll.js";
import * as probeModule from "../../src/simpro/probe.js";

const SIMPRO_BASE = "https://test.simprosuite.com";

let tmpFile: string;
let verifyMock: ReturnType<typeof vi.spyOn>;
let probeMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `enroll-test-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
  verifyMock = vi.spyOn(probeModule, "verifyApiKey");
  probeMock = vi.spyOn(probeModule, "probeCompany");
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  verifyMock.mockRestore();
  probeMock.mockRestore();
});

describe("enrollUser", () => {
  it("returns invalid_key error when Simpro rejects the key", async () => {
    verifyMock.mockResolvedValue({ valid: false, name: null, reason: "invalid_key" });
    const result = await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "bad-key",
      submittedName: "Jane",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_key");
  });

  it("returns no_company_access when key works but neither company grants", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "Jane" });
    probeMock.mockResolvedValue({ granted: false });
    const result = await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "valid-but-no-access",
      submittedName: "Jane",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_company_access");
  });

  it("creates a new user with both companies granted", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "Jane Smith" });
    probeMock.mockResolvedValue({ granted: true });
    const result = await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "good-key",
      submittedName: "Jane Smith",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.smcpToken).toMatch(/^smcp_/);
      expect(result.record.name).toBe("Jane Smith");
      expect(result.record.companyAccess).toEqual(["plumbing", "energy"]);
      expect(result.record.enrolledVia).toBe("self-service");
      expect(result.record.writeEnabled).toBe(true);
    }
  });

  it("creates user with only plumbing when only plumbing granted", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "Bob" });
    probeMock.mockImplementation(async (_base, _key, companyId) => ({
      granted: companyId === "4",
    }));
    const result = await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "plumbing-only",
      submittedName: "Bob",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.companyAccess).toEqual(["plumbing"]);
  });

  it("returns existing smcp_ token when same Simpro key re-enrolls (idempotent)", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "Jane" });
    probeMock.mockResolvedValue({ granted: true });
    const first = await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "same-key",
      submittedName: "Jane",
    });
    const second = await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "same-key",
      submittedName: "Jane Renamed",
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.smcpToken).toBe(first.smcpToken);
      // Idempotency means existing record is returned untouched; submittedName is ignored.
      expect(second.record.name).toBe("Jane");
    }
  });

  it("rejects empty submittedName", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "Jane" });
    probeMock.mockResolvedValue({ granted: true });
    const result = await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "key",
      submittedName: "   ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("name_required");
  });

  it("does NOT change verifyApiKey or probeCompany payloads (passes raw values)", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "X" });
    probeMock.mockResolvedValue({ granted: true });
    await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "leak-check-key",
      submittedName: "X",
    });
    expect(verifyMock).toHaveBeenCalledWith(SIMPRO_BASE, "leak-check-key");
    expect(probeMock).toHaveBeenCalledWith(SIMPRO_BASE, "leak-check-key", "4");
  });
});

describe("unenrollUser", () => {
  it("deletes user when Simpro key matches an existing record", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "X" });
    probeMock.mockResolvedValue({ granted: true });
    await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "wipe-me",
      submittedName: "X",
    });
    const result = await unenrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "wipe-me",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toBe(true);
    // Confirm the file is empty now
    const store = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    expect(Object.keys(store.tokens)).toHaveLength(0);
  });

  it("returns ok:true,removed:false when no record matches (silent for privacy)", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "X" });
    const result = await unenrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "nonexistent",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toBe(false);
  });

  it("rejects invalid Simpro key (can't wipe with a stale leaked key)", async () => {
    verifyMock.mockResolvedValue({ valid: false, name: null, reason: "invalid_key" });
    const result = await unenrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "leaked-but-revoked",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_key");
  });
});

describe("probeForFrontend", () => {
  it("returns the verifyApiKey result + companyAccess detection", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "Tayfun" });
    probeMock.mockImplementation(async (_b, _k, id) => ({ granted: id === "4" }));
    const result = await probeForFrontend({
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "good-key",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.name).toBe("Tayfun");
      expect(result.companyAccess).toEqual(["plumbing"]);
    }
  });

  it("returns valid:false on bad key without probing companies", async () => {
    verifyMock.mockResolvedValue({ valid: false, name: null, reason: "invalid_key" });
    const result = await probeForFrontend({
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "bad",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("invalid_key");
    expect(probeMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- tests/http/enroll.test.ts`
Expected: tests fail because `../../src/http/enroll.js` doesn't exist.

### Task 17: Implement enroll.ts orchestrator

**Files:**
- Create: `src/http/enroll.ts`

- [ ] **Step 1: Write the implementation**

```typescript
// src/http/enroll.ts
// Orchestrators that tie the Simpro probes (src/simpro/probe.ts) and the
// tokens.json CRUD (src/http/tokens.ts) together. Used by the consent page
// (self-service enrollment) and the admin dashboard (manual enrollment).

import { verifyApiKey, probeCompany } from "../simpro/probe.js";
import {
  addUser,
  lookupBySimproKey,
  removeUser,
  type CompanyKey,
  type TokenRecord,
  COMPANY_IDS,
} from "./tokens.js";

export type EnrollReason =
  | "invalid_key"
  | "simpro_unreachable"
  | "no_company_access"
  | "name_required"
  | "unexpected_status";

export interface EnrollSuccess {
  ok: true;
  smcpToken: string;
  record: TokenRecord;
  wasIdempotent: boolean;
}
export interface EnrollFailure {
  ok: false;
  reason: EnrollReason;
}
export type EnrollResult = EnrollSuccess | EnrollFailure;

export interface EnrollInput {
  tokensFile: string;
  simproBaseUrl: string;
  simproApiKey: string;
  submittedName: string;
  /** "self-service" (default) or "manual" — used to set enrolledVia on the record. */
  via?: "self-service" | "manual";
}

/**
 * The main onboarding orchestrator. Validates the Simpro key, detects
 * company access, and either returns an existing user's smcp_ token
 * (idempotent re-enrollment) or creates a brand new record.
 */
export async function enrollUser(input: EnrollInput): Promise<EnrollResult> {
  const name = input.submittedName.trim();
  if (!name) return { ok: false, reason: "name_required" };

  // 1. Validate the key against Simpro /info
  const verify = await verifyApiKey(input.simproBaseUrl, input.simproApiKey);
  if (!verify.valid) {
    return { ok: false, reason: verify.reason ?? "unexpected_status" };
  }

  // 2. Detect company access (both companies probed)
  const companyAccess: CompanyKey[] = [];
  const plumbing = await probeCompany(input.simproBaseUrl, input.simproApiKey, COMPANY_IDS.plumbing);
  if (plumbing.granted) companyAccess.push("plumbing");
  const energy = await probeCompany(input.simproBaseUrl, input.simproApiKey, COMPANY_IDS.energy);
  if (energy.granted) companyAccess.push("energy");
  if (companyAccess.length === 0) {
    return { ok: false, reason: "no_company_access" };
  }

  // 3. Idempotent: return existing record if we've seen this Simpro key
  const existing = lookupBySimproKey(input.tokensFile, input.simproApiKey);
  if (existing) {
    return {
      ok: true,
      smcpToken: existing.smcpToken,
      record: existing.record,
      wasIdempotent: true,
    };
  }

  // 4. Create new record. writeEnabled defaults true per spec section 3.
  const created = addUser(input.tokensFile, {
    name,
    simproApiKey: input.simproApiKey,
    companyAccess,
    writeEnabled: true,
    enrolledVia: input.via ?? "self-service",
  });
  return {
    ok: true,
    smcpToken: created.smcpToken,
    record: created.record,
    wasIdempotent: false,
  };
}

export interface UnenrollInput {
  tokensFile: string;
  simproBaseUrl: string;
  simproApiKey: string;
}

export type UnenrollResult =
  | { ok: true; removed: boolean }
  | { ok: false; reason: EnrollReason };

/**
 * Self-service removal. Requires a still-valid Simpro key as proof of ownership.
 * Returns {ok:true,removed:false} silently when no matching record — don't leak
 * who is or isn't enrolled.
 */
export async function unenrollUser(input: UnenrollInput): Promise<UnenrollResult> {
  const verify = await verifyApiKey(input.simproBaseUrl, input.simproApiKey);
  if (!verify.valid) {
    return { ok: false, reason: verify.reason ?? "unexpected_status" };
  }
  const existing = lookupBySimproKey(input.tokensFile, input.simproApiKey);
  if (!existing) return { ok: true, removed: false };
  const removed = removeUser(input.tokensFile, existing.smcpToken);
  return { ok: true, removed };
}

export interface ProbeFrontendInput {
  simproBaseUrl: string;
  simproApiKey: string;
}

export type ProbeFrontendResult =
  | { valid: true; name: string | null; companyAccess: CompanyKey[] }
  | { valid: false; reason: EnrollReason };

/**
 * Live-probe used by the consent page's AJAX call. Same validation as
 * enrollUser steps 1-2, but doesn't touch tokens.json.
 */
export async function probeForFrontend(input: ProbeFrontendInput): Promise<ProbeFrontendResult> {
  const verify = await verifyApiKey(input.simproBaseUrl, input.simproApiKey);
  if (!verify.valid) {
    return { valid: false, reason: verify.reason ?? "unexpected_status" };
  }
  const companyAccess: CompanyKey[] = [];
  const plumbing = await probeCompany(input.simproBaseUrl, input.simproApiKey, COMPANY_IDS.plumbing);
  if (plumbing.granted) companyAccess.push("plumbing");
  const energy = await probeCompany(input.simproBaseUrl, input.simproApiKey, COMPANY_IDS.energy);
  if (energy.granted) companyAccess.push("energy");
  return { valid: true, name: verify.name, companyAccess };
}
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/http/enroll.test.ts`
Expected: all 11 tests pass.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

### Task 18: Commit Phase 3

```bash
git add src/http/enroll.ts tests/http/enroll.test.ts
git commit -m "feat(enroll): add enrollUser + unenrollUser + probeForFrontend orchestrators"
```

---

## Phase 4 — Replace the consent page (self-service enrollment HTTP layer)

### Task 19: Update consentPage HTML template

**Files:**
- Modify: `src/http/oauth.ts`

- [ ] **Step 1: Replace the consentPage function**

In `src/http/oauth.ts`, locate the `consentPage` function and replace it entirely with:

```typescript
function consentPage(opts: {
  sessionId: string;
  clientName: string;
  errorMessage?: string;
  prefilledName?: string;
}): string {
  const { sessionId, clientName, errorMessage, prefilledName } = opts;
  const safeClient = clientName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 100);
  const errBlock = errorMessage
    ? `<div class="err">${errorMessage
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</div>`
    : "";
  const safePrefilledName = (prefilledName ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .slice(0, 100);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Goldman Simpro AI tool - authorize</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#0f4c75; color:#fff; margin:0; padding:0; min-height:100vh;
         display:flex; align-items:center; justify-content:center; }
  .card { background:#fff; color:#222; max-width:480px; width:90%;
          padding:32px; border-radius:8px; box-shadow:0 8px 32px rgba(0,0,0,0.2); }
  h1 { margin:0 0 8px; font-size:20px; color:#0f4c75; }
  .sub { color:#666; font-size:14px; margin-bottom:24px; }
  .client { background:#eef4fb; padding:8px 12px; border-radius:4px;
            font-size:13px; margin-bottom:16px; }
  label { display:block; margin:14px 0 6px; font-weight:600; font-size:14px; }
  input { width:100%; padding:10px; box-sizing:border-box;
          border:1px solid #ccc; border-radius:4px; font-size:14px; }
  input.simpro-key { font-family: monospace; }
  button { width:100%; padding:12px; background:#0f4c75; color:#fff;
           border:none; border-radius:4px; font-size:15px; font-weight:600;
           cursor:pointer; margin-top:16px; }
  button:hover { background:#1b5e9c; }
  button:disabled { background:#888; cursor:wait; }
  .err { background:#fff3f3; color:#c0392b; padding:10px; border-radius:4px;
         margin-bottom:16px; font-size:13px; border:1px solid #f0c4c0; }
  .info { background:#eaf6ea; color:#1c6b1c; padding:8px 10px;
          border-radius:4px; font-size:13px; margin-top:8px; min-height:18px; }
  .info.error { background:#fff3f3; color:#c0392b; }
  .info:empty { display:none; }
  .help { font-size:12px; color:#888; margin-top:16px; line-height:1.5; }
  .unenroll { font-size:12px; color:#888; margin-top:20px; text-align:center; }
  .unenroll a { color:#888; }
</style>
</head>
<body>
<div class="card">
  <h1>Goldman Simpro AI tool</h1>
  <div class="sub">Authorize this client to access Simpro on your behalf.</div>
  <div class="client">Client: <b>${safeClient}</b></div>
  ${errBlock}
  <form method="POST" action="/authorize/consent" id="enroll-form">
    <input type="hidden" name="session" value="${sessionId}">
    <label for="name">Your full name</label>
    <input type="text" id="name" name="name" autocomplete="name"
           value="${safePrefilledName}" required maxlength="100">
    <label for="simpro_key">Your Simpro API key</label>
    <input type="password" id="simpro_key" name="simpro_key"
           class="simpro-key" autocomplete="off"
           placeholder="paste your Simpro API key" required minlength="20" maxlength="200">
    <div id="probe-info" class="info"></div>
    <button type="submit" id="submit-btn">Authorize</button>
  </form>
  <div class="help">
    Paste the Simpro API key you created in Simpro (gear icon → System → Setup → API Keys).
    We validate it with Simpro and detect which companies (Plumbing, Energy)
    you have access to. After this one-time authorization, Claude Desktop
    will keep you signed in — you won't see this page again on this device.
  </div>
  <div class="unenroll"><a href="/unenroll">Remove my account</a></div>
</div>
<script>
(() => {
  const keyInput = document.getElementById("simpro_key");
  const nameInput = document.getElementById("name");
  const info = document.getElementById("probe-info");
  let timer = null;
  let lastProbed = "";

  function probe() {
    const k = keyInput.value.trim();
    if (k.length < 20 || k === lastProbed) return;
    lastProbed = k;
    info.classList.remove("error");
    info.textContent = "Checking with Simpro...";
    fetch("/enroll/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ simpro_key: k }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.valid) {
          if (!nameInput.value.trim() && data.name) nameInput.value = data.name;
          const access = (data.companyAccess || []).join(", ");
          info.textContent = "Verified. Access: " + (access || "none — see error");
          if (!access) info.classList.add("error");
        } else {
          info.classList.add("error");
          const reasons = {
            invalid_key: "Simpro rejected this key.",
            simpro_unreachable: "Couldn't reach Simpro — check your network.",
            no_company_access: "Key has no access to Plumbing or Energy.",
          };
          info.textContent = reasons[data.reason] || ("Validation failed: " + data.reason);
        }
      })
      .catch(() => {
        info.classList.add("error");
        info.textContent = "Probe failed.";
      });
  }

  keyInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(probe, 600);
  });
})();
</script>
</body>
</html>`;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

### Task 20: Add the /enroll/probe endpoint

**Files:**
- Modify: `src/http/oauth.ts`

- [ ] **Step 1: Import enrollment helpers**

At the top of `src/http/oauth.ts`, after the existing imports, add:

```typescript
import { probeForFrontend, enrollUser } from "./enroll.js";
import { Config } from "../config.js";
```

- [ ] **Step 2: Add a config-bearing parameter to attachConsentRoutes**

Replace the signature of `attachConsentRoutes` from:

```typescript
export function attachConsentRoutes(
  router: Router,
  provider: GoldmanOAuthProvider,
): void {
```

…to:

```typescript
export function attachConsentRoutes(
  router: Router,
  provider: GoldmanOAuthProvider,
  config: Config,
): void {
```

- [ ] **Step 3: Add the probe route inside attachConsentRoutes**

Inside `attachConsentRoutes`, immediately after the `router.get("/authorize", ...)` handler closes, add:

```typescript
  // AJAX endpoint used by the consent page's live probe.
  router.post("/enroll/probe", async (req: Request, res: Response) => {
    const body = req.body as { simpro_key?: string };
    const key = typeof body?.simpro_key === "string" ? body.simpro_key.trim() : "";
    if (key.length < 20) {
      res.status(400).json({ valid: false, reason: "invalid_key" });
      return;
    }
    try {
      const result = await probeForFrontend({
        simproBaseUrl: config.SIMPRO_BASE_URL,
        simproApiKey: key,
      });
      res.json(result);
    } catch (err) {
      log.warn(`/enroll/probe error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ valid: false, reason: "simpro_unreachable" });
    }
  });
```

### Task 21: Replace /authorize/consent handler

**Files:**
- Modify: `src/http/oauth.ts`

- [ ] **Step 1: Replace the existing POST handler**

Inside `attachConsentRoutes`, locate the `router.post("/authorize/consent", ...)` handler and replace its entire body with:

```typescript
  router.post("/authorize/consent", async (req: Request, res: Response) => {
    const { session, name, simpro_key } = req.body as {
      session?: string;
      name?: string;
      simpro_key?: string;
    };
    if (!session || !name || !simpro_key) {
      res.status(400).type("text/plain").send("Missing fields");
      return;
    }
    const pending = provider.consumePending(session);
    if (!pending) {
      res.status(400).type("text/plain").send(
        "Authorization session expired or invalid — please go back to Claude Desktop and click Connect again.",
      );
      return;
    }

    // Run the enrollment orchestrator.
    const result = await enrollUser({
      tokensFile: config.SIMPRO_TOKENS_FILE,
      simproBaseUrl: config.SIMPRO_BASE_URL,
      simproApiKey: simpro_key.trim(),
      submittedName: name.trim(),
      via: "self-service",
    });

    if (!result.ok) {
      // Re-render the consent page with an inline error.
      const reasonMsg: Record<string, string> = {
        invalid_key: "Simpro rejected that API key. Double-check and try again.",
        simpro_unreachable: "Couldn't reach Simpro to verify the key. Wait a minute and retry. If it persists, contact Tayfun.",
        no_company_access: "Your Simpro key doesn't have access to Goldman Plumbing (company 4) or Goldman Energy (company 37). Ask Simpro IT to grant access.",
        name_required: "Please enter your full name.",
        unexpected_status: "Simpro returned an unexpected response. Try again.",
      };
      const newSessionId = provider.beginPending(pending.client, pending.params);
      res.type("text/html").send(
        consentPage({
          sessionId: newSessionId,
          clientName: pending.client.client_name ?? pending.client.client_id,
          errorMessage: reasonMsg[result.reason] ?? `Error: ${result.reason}`,
          prefilledName: name.trim(),
        }),
      );
      return;
    }

    // Audit-log the enrollment outcome.
    log.info(`enroll success: name=${result.record.name} companies=${result.record.companyAccess.join(",")} idempotent=${result.wasIdempotent}`);

    // Stash the issued smcp_ token on res.locals and complete the OAuth handshake.
    (res.locals as { userToken: string }).userToken = result.smcpToken;
    await provider.authorize(pending.client, pending.params, res);
  });
```

### Task 22: Update server.ts to pass config to attachConsentRoutes

**Files:**
- Modify: `src/http/server.ts`

- [ ] **Step 1: Pass config**

In `src/http/server.ts`, find the line:

```typescript
attachConsentRoutes(oauthRouter, oauthProvider);
```

Replace with:

```typescript
attachConsentRoutes(oauthRouter, oauthProvider, config);
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

### Task 23: Add rate limiter for /enroll/probe

**Files:**
- Modify: `src/http/server.ts`

- [ ] **Step 1: Add a new rate limiter alongside consentLimiter**

In `src/http/server.ts`, find the `consentLimiter` definition. Immediately below it, add:

```typescript
  const probeLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { valid: false, reason: "rate_limited" },
  });
```

- [ ] **Step 2: Apply the limiter on the router**

Find the line:

```typescript
  oauthRouter.post("/authorize/consent", consentLimiter);
```

Immediately below it, add:

```typescript
  oauthRouter.post("/enroll/probe", probeLimiter);
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit code 0.

### Task 24: Commit Phase 4

```bash
git add src/http/oauth.ts src/http/server.ts
git commit -m "feat(oauth): replace consent page with self-service Simpro-key flow"
```

---

## Phase 5 — Self-service unenroll

### Task 25: Create unenroll.ts router

**Files:**
- Create: `src/http/unenroll.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/http/unenroll.ts
// Self-service "remove my account" routes. Authenticates by re-presenting
// the Simpro API key, which proves ownership and confirms the key is still
// valid (so a leaked-but-revoked key can't be used to wipe a record).

import { Router, type Request, type Response } from "express";
import { Config } from "../config.js";
import { log } from "../logger.js";
import { unenrollUser } from "./enroll.js";

export function attachUnenrollRoutes(router: Router, config: Config): void {
  router.get("/unenroll", (_req, res) => {
    res
      .type("text/html")
      .set(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      )
      .set("X-Frame-Options", "DENY")
      .send(unenrollPage({}));
  });

  router.post("/unenroll", async (req: Request, res: Response) => {
    const body = req.body as { simpro_key?: string };
    const key = typeof body?.simpro_key === "string" ? body.simpro_key.trim() : "";
    if (key.length < 20) {
      res.type("text/html").send(unenrollPage({ errorMessage: "Please paste a valid Simpro API key." }));
      return;
    }
    const result = await unenrollUser({
      tokensFile: config.SIMPRO_TOKENS_FILE,
      simproBaseUrl: config.SIMPRO_BASE_URL,
      simproApiKey: key,
    });
    if (!result.ok) {
      const reasonMsg: Record<string, string> = {
        invalid_key: "That Simpro key isn't valid. Make sure you're using a current key.",
        simpro_unreachable: "Couldn't reach Simpro to verify the key. Try again.",
        unexpected_status: "Unexpected response from Simpro. Try again.",
      };
      res.type("text/html").send(unenrollPage({
        errorMessage: reasonMsg[result.reason] ?? `Error: ${result.reason}`,
      }));
      return;
    }
    log.info(`unenroll outcome=${result.removed ? "removed" : "no_match"}`);
    res.type("text/html").send(unenrollResultPage(result.removed));
  });
}

function unenrollPage(opts: { errorMessage?: string }): string {
  const err = opts.errorMessage
    ? `<div class="err">${opts.errorMessage.replace(/</g, "&lt;")}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Remove my account - Goldman Simpro AI tool</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#0f4c75; color:#fff; margin:0; padding:0; min-height:100vh;
         display:flex; align-items:center; justify-content:center; }
  .card { background:#fff; color:#222; max-width:480px; width:90%;
          padding:32px; border-radius:8px; }
  h1 { margin:0 0 8px; font-size:20px; color:#0f4c75; }
  .sub { color:#666; font-size:14px; margin-bottom:24px; }
  label { display:block; margin:14px 0 6px; font-weight:600; font-size:14px; }
  input { width:100%; padding:10px; box-sizing:border-box;
          border:1px solid #ccc; border-radius:4px; font-size:14px;
          font-family: monospace; }
  button { width:100%; padding:12px; background:#c0392b; color:#fff;
           border:none; border-radius:4px; font-size:15px; font-weight:600;
           cursor:pointer; margin-top:16px; }
  .err { background:#fff3f3; color:#c0392b; padding:10px; border-radius:4px;
         margin-bottom:16px; font-size:13px; }
  .help { font-size:12px; color:#888; margin-top:16px; line-height:1.5; }
</style>
</head>
<body>
<div class="card">
  <h1>Remove my Goldman Simpro AI account</h1>
  <div class="sub">This deletes your access token. You can re-enroll any time
  with the same Simpro key.</div>
  ${err}
  <form method="POST" action="/unenroll">
    <label for="simpro_key">Your current Simpro API key</label>
    <input type="password" id="simpro_key" name="simpro_key" required minlength="20" maxlength="200">
    <button type="submit">Remove my account</button>
  </form>
  <div class="help">
    We re-verify the key with Simpro to prove it's still yours.
    A revoked or expired Simpro key won't work — get a fresh one if needed.
  </div>
</div>
</body>
</html>`;
}

function unenrollResultPage(removed: boolean): string {
  const msg = removed
    ? "Your account has been removed. Your Claude Desktop connector will stop working until you re-enroll."
    : "No account found for that Simpro key. Nothing to remove.";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Done</title>
<style>
  body { font-family: -apple-system, sans-serif; background:#0f4c75; color:#fff;
         min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { background:#fff; color:#222; max-width:480px; padding:32px; border-radius:8px; }
  h1 { color:#0f4c75; margin:0 0 12px; }
</style></head><body><div class="card">
<h1>Done</h1><p>${msg}</p>
</div></body></html>`;
}
```

### Task 26: Wire unenroll router in server.ts

**Files:**
- Modify: `src/http/server.ts`

- [ ] **Step 1: Import attachUnenrollRoutes**

Add to the imports near `import { GoldmanOAuthProvider, attachConsentRoutes } from "./oauth.js";`:

```typescript
import { attachUnenrollRoutes } from "./unenroll.js";
```

- [ ] **Step 2: Mount the router and add rate limiter**

Just below the existing `oauthRouter.post("/authorize/consent", consentLimiter);` block, add:

```typescript
  const unenrollLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: "Too many attempts. Wait 15 minutes.",
  });
  oauthRouter.post("/unenroll", unenrollLimiter);
  attachUnenrollRoutes(oauthRouter, config);
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit code 0.

### Task 27: Commit Phase 5

```bash
git add src/http/unenroll.ts src/http/server.ts
git commit -m "feat(unenroll): self-service account removal at /unenroll"
```

---

## Phase 6 — Admin auth middleware

### Task 28: Write tests for requireAdmin

**Files:**
- Create: `tests/http/admin.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/http/admin.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { requireAdmin } from "../../src/http/admin.js";

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `admin-test-${Date.now()}-${Math.random()}.json`);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

function buildApp() {
  const app = express();
  app.get("/admin/protected", requireAdmin(tmpFile), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("requireAdmin", () => {
  it("returns 401 when no Authorization header is present", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    const res = await request(buildApp()).get("/admin/protected");
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is not in tokens.json", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    const res = await request(buildApp())
      .get("/admin/protected")
      .set("Authorization", "Bearer smcp_ghost");
    expect(res.status).toBe(401);
  });

  it("returns 403 when token exists but isAdmin is false", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_user": {
          name: "User", simproApiKey: "k1", companyAccess: ["plumbing"],
          isAdmin: false,
        },
      },
    }));
    const res = await request(buildApp())
      .get("/admin/protected")
      .set("Authorization", "Bearer smcp_user");
    expect(res.status).toBe(403);
  });

  it("returns 403 when token exists but isAdmin field is missing", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_user": {
          name: "User", simproApiKey: "k1", companyAccess: ["plumbing"],
        },
      },
    }));
    const res = await request(buildApp())
      .get("/admin/protected")
      .set("Authorization", "Bearer smcp_user");
    expect(res.status).toBe(403);
  });

  it("returns 200 when token is admin", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_admin": {
          name: "Admin", simproApiKey: "k1", companyAccess: ["plumbing"],
          isAdmin: true,
        },
      },
    }));
    const res = await request(buildApp())
      .get("/admin/protected")
      .set("Authorization", "Bearer smcp_admin");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npm test -- tests/http/admin.test.ts`
Expected: tests fail — `requireAdmin` is not yet exported.

### Task 29: Implement requireAdmin

**Files:**
- Create: `src/http/admin.ts`

- [ ] **Step 1: Write the minimal admin.ts**

```typescript
// src/http/admin.ts
// Admin dashboard for managing enrolled users.
// All routes are gated by requireAdmin which checks the smcp_ token's
// isAdmin flag in tokens.json.

import { type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { authenticate } from "./tokens.js";

/**
 * Middleware factory: returns a handler that 401s unauthenticated requests,
 * 403s authenticated-but-non-admin requests, and only lets through requests
 * from tokens whose record has isAdmin=true.
 *
 * The tokens file path is bound at app-setup time so each app can use its own
 * (handy in tests).
 */
export function requireAdmin(tokensFile: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = authenticate(tokensFile, req.headers["authorization"]);
    if (!auth.ok) {
      res.status(auth.status).type("text/plain").send(auth.reason);
      return;
    }
    if (auth.record.isAdmin !== true) {
      res.status(403).type("text/plain").send("Admin access required.");
      return;
    }
    (res.locals as { admin: { name: string; smcpToken: string } }).admin = {
      name: auth.record.name,
      smcpToken: auth.token,
    };
    next();
  };
}
```

- [ ] **Step 2: Run admin tests**

Run: `npm test -- tests/http/admin.test.ts`
Expected: 5 tests pass.

### Task 30: Commit requireAdmin

```bash
git add src/http/admin.ts tests/http/admin.test.ts
git commit -m "feat(admin): requireAdmin middleware gating by isAdmin flag"
```

---

## Phase 7 — Admin dashboard handlers

### Task 31: Create admin-templates.ts

**Files:**
- Create: `src/http/admin-templates.ts`

- [ ] **Step 1: Write the HTML helper file**

```typescript
// src/http/admin-templates.ts
// HTML templates for the admin dashboard. Kept separate from admin.ts so
// the handler logic stays scannable.

import type { TokenRecord } from "./tokens.js";
import { createHash } from "node:crypto";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";
export const ADMIN_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tokenSuffix(token: string): string {
  return token.slice(-6);
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
```

### Task 32: Add list-users handler to admin.ts

**Files:**
- Modify: `src/http/admin.ts`

- [ ] **Step 1: Extend admin.ts with the dashboard router**

Replace the entire `src/http/admin.ts` file with:

```typescript
// src/http/admin.ts
// Admin dashboard for managing enrolled users. All routes are gated by
// requireAdmin which checks the smcp_ token's isAdmin flag in tokens.json.

import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import * as fs from "node:fs";
import { Config } from "../config.js";
import { log } from "../logger.js";
import { authenticate, loadTokens, removeUser, updateUser, type TokenRecord } from "./tokens.js";
import { enrollUser } from "./enroll.js";
import {
  ADMIN_HEADERS,
  keyHash,
  renderDashboard,
  renderAuditView,
  renderManualCreatePage,
  renderManualCreateResult,
} from "./admin-templates.js";

export function requireAdmin(tokensFile: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = authenticate(tokensFile, req.headers["authorization"]);
    if (!auth.ok) {
      res.status(auth.status).type("text/plain").send(auth.reason);
      return;
    }
    if (auth.record.isAdmin !== true) {
      res.status(403).type("text/plain").send("Admin access required.");
      return;
    }
    (res.locals as { admin: { name: string; smcpToken: string } }).admin = {
      name: auth.record.name,
      smcpToken: auth.token,
    };
    next();
  };
}

function withHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(ADMIN_HEADERS)) res.set(k, v);
  return res;
}

function findUserByKeyHash(tokensFile: string, hash: string): { smcpToken: string; record: TokenRecord } | null {
  const store = loadTokens(tokensFile);
  for (const [smcpToken, record] of Object.entries(store.tokens)) {
    if (keyHash(record.simproApiKey) === hash) return { smcpToken, record };
  }
  return null;
}

export function attachAdminRoutes(router: Router, config: Config): void {
  const admin = requireAdmin(config.SIMPRO_TOKENS_FILE);

  // GET /admin — user list
  router.get("/admin", admin, (_req, res) => {
    const store = loadTokens(config.SIMPRO_TOKENS_FILE);
    const users = Object.entries(store.tokens).map(([smcpToken, record]) => ({ smcpToken, record }));
    const adminName = (res.locals as { admin: { name: string } }).admin.name;
    withHeaders(res).type("text/html").send(renderDashboard(adminName, users));
  });

  // POST /admin/users/:hash/revoke
  router.post("/admin/users/:hash/revoke", admin, (req, res) => {
    const found = findUserByKeyHash(config.SIMPRO_TOKENS_FILE, req.params.hash);
    if (!found) {
      res.status(404).type("text/plain").send("User not found");
      return;
    }
    const actor = (res.locals as { admin: { name: string } }).admin.name;
    const ok = removeUser(config.SIMPRO_TOKENS_FILE, found.smcpToken);
    log.info(`admin.action actor=${actor} action=revoke target=${found.record.name} ok=${ok}`);
    res.redirect("/admin");
  });

  // POST /admin/users/:hash/toggle-write
  router.post("/admin/users/:hash/toggle-write", admin, (req, res) => {
    const found = findUserByKeyHash(config.SIMPRO_TOKENS_FILE, req.params.hash);
    if (!found) {
      res.status(404).type("text/plain").send("User not found");
      return;
    }
    const nextValue = !(found.record.writeEnabled ?? false);
    const actor = (res.locals as { admin: { name: string } }).admin.name;
    updateUser(config.SIMPRO_TOKENS_FILE, found.smcpToken, { writeEnabled: nextValue });
    log.info(`admin.action actor=${actor} action=toggle-write target=${found.record.name} newValue=${nextValue}`);
    res.redirect("/admin");
  });

  // GET /admin/audit
  router.get("/admin/audit", admin, (_req, res) => {
    let lines: string[] = [];
    try {
      const raw = fs.readFileSync(config.SIMPRO_AUDIT_FILE, "utf8");
      lines = raw.split("\n").filter((l) => l.length > 0).slice(-100);
    } catch {
      // File may not exist yet — fine.
    }
    const adminName = (res.locals as { admin: { name: string } }).admin.name;
    withHeaders(res).type("text/html").send(renderAuditView(adminName, lines));
  });

  // GET /admin/users/new — manual create form
  router.get("/admin/users/new", admin, (_req, res) => {
    withHeaders(res).type("text/html").send(renderManualCreatePage());
  });

  // POST /admin/users — manual create submission
  router.post("/admin/users", admin, async (req, res) => {
    const { name, simpro_key } = req.body as { name?: string; simpro_key?: string };
    if (!name || !simpro_key) {
      withHeaders(res).type("text/html").send(renderManualCreatePage({
        errorMessage: "Both name and Simpro key required.",
        submittedName: name,
      }));
      return;
    }
    const result = await enrollUser({
      tokensFile: config.SIMPRO_TOKENS_FILE,
      simproBaseUrl: config.SIMPRO_BASE_URL,
      simproApiKey: simpro_key.trim(),
      submittedName: name.trim(),
      via: "manual",
    });
    if (!result.ok) {
      const messages: Record<string, string> = {
        invalid_key: "Simpro rejected that key.",
        simpro_unreachable: "Couldn't reach Simpro. Try again.",
        no_company_access: "Key has no access to Plumbing or Energy.",
        name_required: "Name required.",
        unexpected_status: "Simpro returned an unexpected response.",
      };
      withHeaders(res).type("text/html").send(renderManualCreatePage({
        errorMessage: messages[result.reason] ?? `Error: ${result.reason}`,
        submittedName: name,
        submittedKey: simpro_key,
      }));
      return;
    }
    const actor = (res.locals as { admin: { name: string } }).admin.name;
    log.info(`admin.action actor=${actor} action=create target=${result.record.name} idempotent=${result.wasIdempotent}`);
    withHeaders(res).type("text/html").send(renderManualCreateResult(result.record, result.smcpToken));
  });
}
```

### Task 33: Mount admin router in server.ts

**Files:**
- Modify: `src/http/server.ts`

- [ ] **Step 1: Import the router attacher**

Add to imports:

```typescript
import { attachAdminRoutes } from "./admin.js";
```

- [ ] **Step 2: Add admin rate limiter and mount**

Just below the existing `attachUnenrollRoutes(oauthRouter, config);` line (added in Task 26), add:

```typescript
  const adminLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: "Too many admin requests.",
  });
  const adminRouter = Router();
  adminRouter.use("/admin", adminLimiter);
  attachAdminRoutes(adminRouter, config);
  app.use(adminRouter);
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit code 0.

### Task 34: Commit Phase 7

```bash
git add src/http/admin.ts src/http/admin-templates.ts src/http/server.ts tests/http/admin.test.ts
git commit -m "feat(admin): dashboard with view/revoke/toggle-write/audit/manual-create"
```

---

## Phase 8 — Docs

### Task 35: Simplify COWORKER-CONNECT.md

**Files:**
- Modify: `docs/COWORKER-CONNECT.md` (or `COWORKER-CONNECT.md` at project root — check existing location)

- [ ] **Step 1: Locate the file**

Run: `git ls-files | grep -i coworker`
Expected: prints the path to the existing file.

- [ ] **Step 2: Find the "Part 2 — Send your Simpro API key to IT" section**

Open the file. Locate "Part 2 — Send your Simpro API key to IT" and replace the entire Part 1 + Part 2 + Part 3 sections with a single combined section. Replace lines for these three Parts with:

```markdown
## Part 1 — Get your Simpro API key (2 minutes)

Each person uses their own Simpro key so Simpro's audit log shows who did what.

1. Log into Simpro: <https://goldmanplumbingservices.simprosuite.com>
2. Click the **gear icon** (top right) → **System** → **Setup** → **API Keys** → **Add**.
3. Name it after yourself, e.g. `Jane Smith - Claude Desktop`.
4. Linked Employee: choose your own employee record.
5. Permissions: read-only is fine to start.
6. Click **Save**. Simpro shows the **Access Token** — a long string. **Copy it now** — Simpro shows it only once.

Treat this token like a password. Save it in your password manager.

## Part 2 — Add the connector in Claude Desktop (1 minute)

1. Open **Claude Desktop**.
2. Menu icon (top-left or profile circle) → **Settings** → **Connectors**.
3. Scroll down → **Add custom connector**.
4. Fill in:
   - **Name:** `Goldman Plumbing`
   - **Remote MCP server URL:** `https://goldman-ubuntu.tail6b5a4b.ts.net/mcp/plumbing`
   - Leave the **Advanced settings** fields (OAuth Client ID, OAuth Client Secret) **empty**.
5. Click **Add**.
6. (Optional) Repeat with Name `Goldman Energy` and URL ending in `/mcp/energy`.

## Part 3 — Connect (1 minute)

1. Click **Connect** on the new connector. Your default browser opens a Goldman page.
2. The page asks for your **Simpro API key** (the one from Part 1) and your **name**.
3. Paste the key, check your name (auto-detected), click **Authorize**.
4. The browser returns to Claude Desktop and the connector shows **Connected**.
5. If you added Energy too, do the same for it.

**No second token. No emailing IT. No waiting.**
```

- [ ] **Step 3: Update the "Common problems" table**

Find the table starting `| Problem | Fix |`. Replace the row beginning `| Consent page says "That token is not registered"` with:

```markdown
| Page says "Simpro rejected that API key" | The Simpro key was typed/pasted wrong, or it was deleted in Simpro. Generate a fresh one (Part 1) and try again. |
| Page says "no access to Goldman companies" | Your Simpro user account doesn't have access to company 4 or 37. Ask Simpro IT (Tayfun) to grant access. |
| Page says "Couldn't reach Simpro" | Simpro's API is slow or down. Wait a minute and retry. |
```

- [ ] **Step 4: Drop the "Rotating your tokens" section**

Find the section starting `## Rotating your tokens`. Replace its content with:

```markdown
## Rotating your tokens

If you suspect your Simpro key leaked, leave Goldman, or just want fresh
credentials:

- Log into Simpro, delete the old key, create a new one.
- Re-click **Connect** in Claude Desktop and paste the new Simpro key.

If you want to completely remove your AI tool access:

- Open <https://goldman-ubuntu.tail6b5a4b.ts.net/unenroll> in your browser.
- Paste your current Simpro key. Click Remove.
```

### Task 36: Write docs/ADMIN.md

**Files:**
- Create: `docs/ADMIN.md`

- [ ] **Step 1: Write the file**

```markdown
# Admin dashboard

The admin dashboard at `/admin` lets admins manage enrolled users without
SSHing to the Ubuntu server.

## Granting admin to a user

There's no in-app "make this user admin" button in v1 — it's a one-line
edit to `tokens.json`.

1. SSH to Ubuntu.
2. `sudo nano /opt/simpro-mcp/tokens.json`
3. Find the target user's record by `name`.
4. Add `"isAdmin": true,` inside their record (e.g. just before `"createdAt"`).
5. Save.

The next request loads the updated file (mtime cache). No restart needed.

## What the dashboard does (v1)

| Action | URL | Description |
|---|---|---|
| List users | `GET /admin` | All enrolled users with company access, write status, last-used, enrolled-via |
| Revoke user | `POST /admin/users/:hash/revoke` | Deletes the user's record. Their Claude Desktop connector starts 401-ing. |
| Toggle write access | `POST /admin/users/:hash/toggle-write` | Flips writeEnabled on/off |
| View audit log | `GET /admin/audit` | Last 100 lines of `/opt/simpro-mcp/audit.log` |
| Create user manually | `GET /admin/users/new` + `POST /admin/users` | Same validation as self-service but admin-driven. Useful for non-technical coworkers. |

## How admin auth works

Admins authenticate using their normal `smcp_` token (the one Claude Desktop
uses to call MCP endpoints). Open the dashboard in a private/incognito browser
window with the Authorization header set, or use a browser extension that
injects headers.

Easiest: open the dashboard from a Claude Desktop session by asking Claude
"open the admin dashboard URL with my smcp_ token" — but most browsers won't
let you set Authorization for navigation requests. In practice, use `curl`
for one-off admin actions, or set up a small bookmarklet that adds the
header for browser-based use.

A future v2 may add a simple session cookie login flow for the dashboard so
the smcp_ token bookmarklet isn't needed.

## What the dashboard doesn't do (v2+)

- Self-service "grant admin to another user"
- Token rotation
- Bulk export
- Edit display name
```

### Task 37: Commit Phase 8

```bash
git add COWORKER-CONNECT.md docs/ADMIN.md
git commit -m "docs: simplified coworker setup + new admin dashboard guide"
```

---

## Phase 9 — Final integration check

### Task 38: Run the full test suite

- [ ] **Step 1: All tests pass**

Run: `npm test`
Expected: all tests pass (probe + tokens + enroll + admin + sanity).

- [ ] **Step 2: Typecheck clean**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Build succeeds**

Run: `npm run build`
Expected: exit code 0.

### Task 39: Smoke-test against a running server (manual)

Follow tests T1–T9 from the design doc `docs/superpowers/specs/2026-05-11-self-service-enrollment-design.md`, Section 9.

For each test:

- [ ] **T1 — Happy path self-service**

On Ubuntu:
```bash
cd /opt/simpro-mcp && git pull && npm ci && npm run build && sudo systemctl restart simpro-mcp
sudo systemctl status simpro-mcp --no-pager | head -5
```

In a browser, open the URL Claude Desktop would open during Connect (use the existing `/authorize` endpoint with PKCE params). Paste a test Simpro API key. Check that:
- Live probe shows name + access within ~600 ms
- Click Authorize → redirects back to Claude Desktop
- `cat /opt/simpro-mcp/tokens.json` shows the new user with `enrolledVia: "self-service"`
- `tail -5 /opt/simpro-mcp/audit.log` shows the enroll success line

- [ ] **T2–T9** — run each, mark as passing.

### Task 40: Final commit (if anything else changed)

```bash
git status
# review
git add -A
git commit -m "feat: self-service enrollment + admin dashboard"
```

### Task 41: Deploy to Ubuntu

```bash
# On dev / Windows
git push

# On Ubuntu (over RustDesk)
cd /opt/simpro-mcp
sudo -u simpro-mcp git pull
sudo -u simpro-mcp npm ci
sudo -u simpro-mcp npm run build
sudo -u simpro-mcp npm prune --omit=dev
sudo systemctl restart simpro-mcp
sudo systemctl status simpro-mcp --no-pager | head -5
sudo journalctl -u simpro-mcp --since "30 seconds ago" --no-pager | tail -20
```

Check the journal output for startup errors. If clean, proceed to T1–T9 testing.

### Task 42: Make Tayfun admin (one-time setup)

```bash
# On Ubuntu
sudo nano /opt/simpro-mcp/tokens.json
```

Find Tayfun's record, add `"isAdmin": true,` line. Save. Test:

```bash
curl -H "Authorization: Bearer smcp_RVbocdemffvtaM1P2jgbCQYyuWhYtBCdG4m5HChGX7k" https://goldman-ubuntu.tail6b5a4b.ts.net/admin
```

Expected: HTML response (the dashboard).

### Task 43: Send the simplified coworker email

Use the template in design doc Section 12. Send to Sinan first as the pilot.

---

## Self-review checklist

After implementing this plan:

- [ ] All spec sections (1–11) have at least one task implementing them — confirmed:
  - Section 1 (enrollment UX): Tasks 19–22
  - Section 2 (unenroll): Tasks 25–27
  - Section 3 (admin dashboard): Tasks 28–34
  - Section 4 (data model): Tasks 8–15
  - Section 5 (endpoints): Tasks 19–34 across all phases
  - Section 6 (code surface): file paths match
  - Section 7 (rate limits): Tasks 23, 26, 33
  - Section 8 (audit log): integrated into Tasks 21, 25, 32 (info log lines)
  - Section 9 (test plan): Task 39 walks T1–T9
  - Section 10 (rollout): Tasks 41–43
  - Section 11 (risks): addressed inline (graceful name detection, schema additions, idempotent re-enrollment)
- [ ] No placeholders; every code block is concrete
- [ ] Type consistency: `TokenRecord` fields, `EnrollResult` discriminated union, and `keyHash` URL scheme are consistent across tasks

---

End of plan.
