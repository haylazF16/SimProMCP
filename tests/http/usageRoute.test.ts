// tests/http/usageRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import request from "supertest";
import { attachAdminRoutes } from "../../src/http/admin.js";
import type { Config } from "../../src/config.js";

let tokensFile: string;
let auditFile: string;

beforeEach(() => {
  const suffix = `${Date.now()}-${Math.random()}`;
  tokensFile = path.join(os.tmpdir(), `usage-tokens-${suffix}.json`);
  auditFile = path.join(os.tmpdir(), `usage-audit-${suffix}.log`);
});

afterEach(() => {
  for (const f of [tokensFile, auditFile]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const config = {
    SIMPRO_TOKENS_FILE: tokensFile,
    SIMPRO_BASE_URL: "https://test.simprosuite.com",
    SIMPRO_AUDIT_FILE: auditFile,
  } as unknown as Config;
  const router = express.Router();
  attachAdminRoutes(router, config);
  app.use(router);
  return app;
}

function writeAdminToken() {
  fs.writeFileSync(tokensFile, JSON.stringify({
    tokens: {
      "smcp_admin": {
        name: "Tayfun", simproApiKey: "k1admin-12345",
        companyAccess: ["plumbing"], isAdmin: true,
      },
    },
  }));
}

describe("GET /admin/usage", () => {
  it("returns 401 when no auth is given", async () => {
    fs.writeFileSync(tokensFile, JSON.stringify({ tokens: {} }));
    const res = await request(buildApp()).get("/admin/usage");
    expect(res.status).toBe(401);
  });

  it("returns 403 when authed user is not admin", async () => {
    fs.writeFileSync(tokensFile, JSON.stringify({
      tokens: {
        "smcp_user": {
          name: "User", simproApiKey: "k1user-12345",
          companyAccess: ["plumbing"], isAdmin: false,
        },
      },
    }));
    const res = await request(buildApp())
      .get("/admin/usage")
      .set("Authorization", "Bearer smcp_user");
    expect(res.status).toBe(403);
  });

  it("returns 200 HTML with the admin's name and KPI labels for an admin", async () => {
    writeAdminToken();
    // Seed one audit line so the page renders some data.
    fs.writeFileSync(auditFile, JSON.stringify({
      ts: new Date().toISOString(),
      user: "Tayfun", company: "plumbing", tool: "simpro_search_jobs",
      ok: true, durationMs: 42,
    }) + "\n");
    const res = await request(buildApp())
      .get("/admin/usage")
      .set("Authorization", "Bearer smcp_admin");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("Tayfun");
    expect(res.text).toContain("Today");
    expect(res.text).toContain("Hour of day");
    // Security headers should be applied (same as other /admin/* pages).
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });
});
