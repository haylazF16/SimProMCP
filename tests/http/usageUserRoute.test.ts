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
  tokensFile = path.join(os.tmpdir(), `uud-tokens-${suffix}.json`);
  auditFile = path.join(os.tmpdir(), `uud-audit-${suffix}.log`);
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

function writeAdminAndUser() {
  fs.writeFileSync(tokensFile, JSON.stringify({
    tokens: {
      "smcp_admin": {
        name: "Tayfun", simproApiKey: "k1admin-12345",
        companyAccess: ["plumbing", "energy"], isAdmin: true,
      },
      "smcp_sarah": {
        name: "Sarah", simproApiKey: "k1sarah-12345",
        companyAccess: ["plumbing"], isAdmin: false,
      },
    },
  }));
  fs.writeFileSync(auditFile, [
    JSON.stringify({ ts: new Date().toISOString(), user: "Sarah", company: "plumbing",
                     tool: "simpro_search_jobs", ok: true, durationMs: 100, details: "q=goldman" }),
    JSON.stringify({ ts: new Date().toISOString(), user: "Sarah", company: "plumbing",
                     tool: "simpro_get_invoice", ok: true, durationMs: 90, details: "#42" }),
    JSON.stringify({ ts: new Date().toISOString(), user: "Tayfun", company: "energy",
                     tool: "simpro_search_jobs", ok: true, durationMs: 50 }),
  ].join("\n") + "\n");
}

describe("GET /admin/usage/:userName", () => {
  it("returns 401 unauth", async () => {
    fs.writeFileSync(tokensFile, JSON.stringify({ tokens: {} }));
    const res = await request(buildApp()).get("/admin/usage/Sarah");
    expect(res.status).toBe(401);
  });

  it("returns 200 with the user's stats for an admin", async () => {
    writeAdminAndUser();
    const res = await request(buildApp())
      .get("/admin/usage/Sarah")
      .set("Authorization", "Bearer smcp_admin");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Sarah");
    expect(res.text).toContain("Activity"); // recent-activity feed heading
    // Per-user tools list should mention something from her tools.
    expect(res.text).toMatch(/(simpro_search_jobs|simpro_get_invoice)/);
  });

  it("returns 404 for an unknown user (not enrolled and never seen in audit log)", async () => {
    writeAdminAndUser();
    const res = await request(buildApp())
      .get("/admin/usage/NeverWasHere")
      .set("Authorization", "Bearer smcp_admin");
    expect(res.status).toBe(404);
  });

  it("excludes audit lines outside the picked range from the recent-activity feed", async () => {
    fs.writeFileSync(tokensFile, JSON.stringify({
      tokens: {
        "smcp_admin": {
          name: "Tayfun", simproApiKey: "k1admin-12345",
          companyAccess: ["plumbing"], isAdmin: true,
        },
      },
    }));
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const fortyDaysAgo = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(auditFile, [
      JSON.stringify({ ts: oneHourAgo, user: "Tayfun", company: "plumbing",
                       tool: "simpro_get_invoice", ok: true, durationMs: 10, details: "#recent" }),
      JSON.stringify({ ts: fortyDaysAgo, user: "Tayfun", company: "plumbing",
                       tool: "simpro_search_jobs", ok: true, durationMs: 20, details: "#old" }),
    ].join("\n") + "\n");
    // 7d range — only the 1h-ago row should appear in the recent feed.
    const res = await request(buildApp())
      .get("/admin/usage/Tayfun?range=7d")
      .set("Authorization", "Bearer smcp_admin");
    expect(res.status).toBe(200);
    expect(res.text).toContain("#recent");
    expect(res.text).not.toContain("#old");
  });
});
