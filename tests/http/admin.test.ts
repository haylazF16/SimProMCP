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
});
