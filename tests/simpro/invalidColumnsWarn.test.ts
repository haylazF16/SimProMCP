// tests/simpro/invalidColumnsWarn.test.ts
//
// Regression: the SimproClient must log a structured WARN whenever Simpro
// rejects a columns= selector, REGARDLESS of HTTP status. The first version
// of this detector (207c6fb) gated on `res.status === 400` and was therefore
// silently dead: the real responses are 400 on /jobs/ ("Invalid columns:
// JobNumber") AND 422 on /sites/ ("Invalid columns found", value "Customer").
// These tests pin the status-agnostic behaviour so the detector can't regress
// back to a single hard-coded status.

import { describe, it, expect, vi, afterEach } from "vitest";
import { SimproClient } from "../../src/simpro/client.js";
import { SimproApiError } from "../../src/simpro/errors.js";
import type { Config } from "../../src/config.js";

function fakeConfig(): Config {
  return {
    SIMPRO_BASE_URL: "https://example.test",
    SIMPRO_API_KEY: "key-1234567890",
    SIMPRO_COMPANY_ID: "0",
    SIMPRO_REQUEST_TIMEOUT_MS: 5000,
  } as unknown as Config;
}

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal("fetch", async () => ({
    ok: false,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }));
}

function captureStderr(): { lines: () => string } {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines: () => spy.mock.calls.map((c) => String(c[0])).join("") };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SimproClient — Invalid columns WARN detector", () => {
  it("warns on a 422 'Invalid columns found' body (the /sites/ case)", async () => {
    const err = captureStderr();
    stubFetch(422, { errors: [{ message: "Invalid columns found", value: "Customer" }] });
    const client = new SimproClient(fakeConfig());

    await expect(client.get("/sites/")).rejects.toBeInstanceOf(SimproApiError);

    const logged = err.lines();
    expect(logged).toContain("rejected columns selector");
    expect(logged).toContain("status 422");
  });

  it("warns on a 400 'Invalid columns: JobNumber' body (the /jobs/ case)", async () => {
    const err = captureStderr();
    stubFetch(400, "Invalid columns: JobNumber");
    const client = new SimproClient(fakeConfig());

    await expect(client.get("/jobs/")).rejects.toBeInstanceOf(SimproApiError);

    expect(err.lines()).toContain("rejected columns selector");
  });

  it("does NOT warn for an unrelated error body", async () => {
    const err = captureStderr();
    stubFetch(404, { error: "Not found" });
    const client = new SimproClient(fakeConfig());

    await expect(client.get("/jobs/999/")).rejects.toBeInstanceOf(SimproApiError);

    expect(err.lines()).not.toContain("rejected columns selector");
  });

  it("does NOT warn on a 5xx even if the body mentions invalid columns", async () => {
    // The detector is gated to 4xx: outage-era 5xx bodies (often large HTML
    // pages, re-fetched once per retry attempt) must not trigger the WARN.
    const err = captureStderr();
    stubFetch(500, "<html>Internal error: invalid columns in view</html>");
    const client = new SimproClient(fakeConfig());

    await expect(client.get("/jobs/")).rejects.toBeInstanceOf(SimproApiError);

    expect(err.lines()).not.toContain("rejected columns selector");
  });
});
