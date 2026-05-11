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
      simproApiKey: "bad-key-12345",
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
      simproApiKey: "valid-but-no-access-12345",
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
      simproApiKey: "good-key-12345",
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
      simproApiKey: "plumbing-only-12345",
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
      simproApiKey: "same-key-12345",
      submittedName: "Jane",
    });
    const second = await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "same-key-12345",
      submittedName: "Jane Renamed",
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.smcpToken).toBe(first.smcpToken);
      expect(second.record.name).toBe("Jane");
    }
  });

  it("rejects empty submittedName", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "Jane" });
    probeMock.mockResolvedValue({ granted: true });
    const result = await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "valid-key-12345",
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
      simproApiKey: "leak-check-key-12345",
      submittedName: "X",
    });
    expect(verifyMock).toHaveBeenCalledWith(SIMPRO_BASE, "leak-check-key-12345");
    expect(probeMock).toHaveBeenCalledWith(SIMPRO_BASE, "leak-check-key-12345", "4");
  });
});

describe("unenrollUser", () => {
  it("deletes user when Simpro key matches an existing record", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "X" });
    probeMock.mockResolvedValue({ granted: true });
    await enrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "wipe-me-12345",
      submittedName: "X",
    });
    const result = await unenrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "wipe-me-12345",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toBe(true);
    const store = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    expect(Object.keys(store.tokens)).toHaveLength(0);
  });

  it("returns ok:true,removed:false when no record matches (silent for privacy)", async () => {
    verifyMock.mockResolvedValue({ valid: true, name: "X" });
    const result = await unenrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "nonexistent-12345",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toBe(false);
  });

  it("rejects invalid Simpro key (can't wipe with a stale leaked key)", async () => {
    verifyMock.mockResolvedValue({ valid: false, name: null, reason: "invalid_key" });
    const result = await unenrollUser({
      tokensFile: tmpFile,
      simproBaseUrl: SIMPRO_BASE,
      simproApiKey: "leaked-but-revoked-12345",
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
      simproApiKey: "good-key-12345",
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
      simproApiKey: "bad-12345",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("invalid_key");
    expect(probeMock).not.toHaveBeenCalled();
  });
});
