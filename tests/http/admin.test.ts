// tests/http/admin.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import request from "supertest";
import { requireAdmin, attachAdminRoutes } from "../../src/http/admin.js";
import type { Config } from "../../src/config.js";

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

/** App with the real admin router mounted, for login / cookie / redirect tests. */
function buildFullAdminApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  // Minimal Config shape — only the fields admin.ts reads.
  const config = {
    SIMPRO_TOKENS_FILE: tmpFile,
    SIMPRO_BASE_URL: "https://test.simprosuite.com",
    SIMPRO_AUDIT_FILE: path.join(os.tmpdir(), `audit-${Math.random()}.log`),
  } as unknown as Config;
  const router = express.Router();
  attachAdminRoutes(router, config);
  app.use(router);
  return app;
}

function writeAdminToken(token: string, name = "Admin") {
  fs.writeFileSync(tmpFile, JSON.stringify({
    tokens: {
      [token]: {
        name,
        simproApiKey: "k1admin-12345",
        companyAccess: ["plumbing"],
        isAdmin: true,
      },
    },
  }));
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
          name: "User", simproApiKey: "k1user-12345", companyAccess: ["plumbing"],
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
          name: "User", simproApiKey: "k1user-12345", companyAccess: ["plumbing"],
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
          name: "Admin", simproApiKey: "k1admin-12345", companyAccess: ["plumbing"],
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

  it("redirects to /admin/login when browser-style GET has no auth", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    const res = await request(buildApp())
      .get("/admin/protected")
      .set("Accept", "text/html");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/admin/login");
  });

  it("returns 401 plain text when API-style GET has no auth", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    const res = await request(buildApp())
      .get("/admin/protected")
      .set("Accept", "application/json");
    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
  });

  it("accepts admin via session cookie (goldman_admin_session)", async () => {
    writeAdminToken("smcp_cookie_admin");
    const res = await request(buildApp())
      .get("/admin/protected")
      .set("Cookie", "goldman_admin_session=smcp_cookie_admin");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("POST /admin/login", () => {
  it("rejects unknown token and does NOT set a cookie", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    const res = await request(buildFullAdminApp())
      .post("/admin/login")
      .type("form")
      .send({ smcp_token: "smcp_ghost" });
    // Re-renders the form (200 with HTML), no Set-Cookie header
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects non-admin token even if it's a valid user", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_plainuser": {
          name: "Plain", simproApiKey: "k1plain-12345", companyAccess: ["plumbing"],
        },
      },
    }));
    const res = await request(buildFullAdminApp())
      .post("/admin/login")
      .type("form")
      .send({ smcp_token: "smcp_plainuser" });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("on valid admin token: sets the session cookie and redirects to /admin", async () => {
    writeAdminToken("smcp_login_admin");
    const res = await request(buildFullAdminApp())
      .post("/admin/login")
      .type("form")
      .send({ smcp_token: "smcp_login_admin" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/admin");
    const setCookie = res.headers["set-cookie"];
    const cookieLine = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieLine).toBeDefined();
    expect(cookieLine).toContain("goldman_admin_session=smcp_login_admin");
    expect(cookieLine).toContain("HttpOnly");
    expect(cookieLine).toContain("Secure");
    expect(cookieLine).toContain("SameSite=Strict");
    expect(cookieLine).toContain("Path=/admin");
    expect(cookieLine).toContain("Max-Age=86400");
  });
});
