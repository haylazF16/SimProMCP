// tests/http/authOrDefault.test.ts
//
// Covers SIMPRO_REQUIRE_AUTH=false ("no login, just works" trial mode):
// an unauthenticated /mcp request must resolve to a default identity instead
// of 401, so Claude connects with no consent page or redirect. When
// requireAuth is true the behaviour is identical to authenticate().

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { authenticateOrDefault } from "../../src/http/tokens.js";

let dir: string;
let tokensFile: string;

function writeTokens(obj: unknown): void {
  fs.writeFileSync(tokensFile, JSON.stringify(obj), "utf8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "simpro-tok-"));
  tokensFile = path.join(dir, "tokens.json");
  writeTokens({
    tokens: {
      smcp_alice: { name: "Alice", simproApiKey: "alicekey12345", companyAccess: ["plumbing", "energy"] },
      smcp_bob: { name: "Bob", simproApiKey: "bobkey1234567", companyAccess: ["energy"] },
    },
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("authenticateOrDefault", () => {
  it("requireAuth=true + no header → 401 (unchanged login behaviour)", () => {
    const r = authenticateOrDefault(tokensFile, undefined, { requireAuth: true, company: "energy" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("requireAuth=false + no header → default identity for the company (no 401)", () => {
    const r = authenticateOrDefault(tokensFile, undefined, { requireAuth: false, company: "energy" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.viaDefault).toBe(true);
      // First record with energy access wins (Alice precedes Bob).
      expect(r.record.name).toBe("Alice");
    }
  });

  it("requireAuth=false + valid bearer → that user wins (per-user attribution kept)", () => {
    const r = authenticateOrDefault(tokensFile, "Bearer smcp_bob", { requireAuth: false, company: "energy" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.name).toBe("Bob");
      expect(r.viaDefault).toBeUndefined();
    }
  });

  it("requireAuth=false + unknown bearer → still falls back to default", () => {
    const r = authenticateOrDefault(tokensFile, "Bearer smcp_nope", { requireAuth: false, company: "plumbing" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.name).toBe("Alice");
  });

  it("requireAuth=false but no record has access to the company → 503, not 401", () => {
    writeTokens({ tokens: { smcp_bob: { name: "Bob", simproApiKey: "bobkey1234567", companyAccess: ["energy"] } } });
    const r = authenticateOrDefault(tokensFile, undefined, { requireAuth: false, company: "plumbing" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });
});
