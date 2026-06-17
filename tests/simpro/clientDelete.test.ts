// tests/simpro/clientDelete.test.ts
//
// del() must issue a real DELETE through the core request() path AND be
// non-retryable: DELETE is not in DEFAULT_RETRYABLE_METHODS, so even a 500
// (a status request() WOULD retry for a GET) must hit the wire exactly once.
// We mock global fetch (the same convention as invalidColumnsWarn.test.ts /
// probe.test.ts) rather than stubbing the private doFetch, so the assertions
// cover the actual verb/URL/headers on the wire and genuinely exercise — and
// thereby prove the absence of — the retry loop.

import { describe, it, expect, vi, afterEach } from "vitest";
import { SimproClient } from "../../src/simpro/client.js";
import { SimproApiError } from "../../src/simpro/errors.js";
import type { Config } from "../../src/config.js";

const cfg = {
  SIMPRO_BASE_URL: "https://x.simprosuite.com",
  SIMPRO_API_KEY: "key12345",
  SIMPRO_COMPANY_ID: "4",
  SIMPRO_REQUEST_TIMEOUT_MS: 1000,
} as unknown as Config;

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(status: number, body: unknown): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  });
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SimproClient.del", () => {
  it("issues a DELETE to the given path with the auth header", async () => {
    const { calls } = stubFetch(200, {});
    const client = new SimproClient(cfg);

    await client.del("/companies/4/jobs/1/attachments/files/9");

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toBe(
      "https://x.simprosuite.com/companies/4/jobs/1/attachments/files/9",
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer key12345");
  });

  it("does NOT retry — a 500 hits the wire exactly once (DELETE is non-idempotent)", async () => {
    // 500 is a status request() retries for GET/HEAD; DELETE must not, so the
    // mock must be called exactly once and the error surfaces immediately.
    const { calls } = stubFetch(500, "boom");
    const client = new SimproClient(cfg);

    await expect(
      client.del("/companies/4/jobs/1/attachments/files/9"),
    ).rejects.toBeInstanceOf(SimproApiError);

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("DELETE");
  });
});
