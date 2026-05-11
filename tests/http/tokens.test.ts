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
        "smcp_abc": { name: "A", simproApiKey: "key-aaaa", companyAccess: ["plumbing"] },
        "smcp_xyz": { name: "B", simproApiKey: "key-bbbb", companyAccess: ["energy"] },
      },
    }));
    const found = lookupBySimproKey(tmpFile, "key-bbbb");
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
  it("creates a new record and returns the generated smcp token", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    const result = await addUser(tmpFile, {
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

  it("does NOT allow isAdmin to be set at creation (privilege escalation guard)", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    // Even if the caller tries via 'as any' bypass, isAdmin must not appear on the record.
    const result = await addUser(tmpFile, {
      name: "Sneaky",
      simproApiKey: "key-sneak",
      companyAccess: ["plumbing"],
      writeEnabled: true,
      enrolledVia: "self-service",
      // @ts-expect-error: deliberately violating types to verify runtime guard
      isAdmin: true,
    });
    // The TS type omits isAdmin, but a runtime caller using `as any` could
    // pass it through. The implementation must drop it.
    const after = loadTokens(tmpFile);
    expect(after.tokens[result.smcpToken].isAdmin).toBe(false);
  });
});

describe("removeUser", () => {
  it("deletes the record for the given smcp token", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_keep": { name: "Keep", simproApiKey: "key-keep", companyAccess: ["plumbing"] },
        "smcp_drop": { name: "Drop", simproApiKey: "key-drop", companyAccess: ["plumbing"] },
      },
    }));
    const removed = await removeUser(tmpFile, "smcp_drop");
    expect(removed).toBe(true);
    const after = loadTokens(tmpFile);
    expect(after.tokens["smcp_drop"]).toBeUndefined();
    expect(after.tokens["smcp_keep"]).toBeDefined();
  });

  it("returns false when the token doesn't exist", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    expect(await removeUser(tmpFile, "smcp_nonexistent")).toBe(false);
  });
});

describe("updateUser", () => {
  it("merges the patch into the existing record", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      tokens: {
        "smcp_one": {
          name: "User",
          simproApiKey: "key-one1",
          companyAccess: ["plumbing"],
          writeEnabled: false,
        },
      },
    }));
    const updated = await updateUser(tmpFile, "smcp_one", { writeEnabled: true });
    expect(updated).toBe(true);
    const after = loadTokens(tmpFile);
    expect(after.tokens["smcp_one"].writeEnabled).toBe(true);
    expect(after.tokens["smcp_one"].name).toBe("User");
  });

  it("returns false when the token doesn't exist", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ tokens: {} }));
    expect(await updateUser(tmpFile, "smcp_nope", { writeEnabled: true })).toBe(false);
  });
});
