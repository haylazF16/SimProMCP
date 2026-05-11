// tests/simpro/probe.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("returns simpro_unreachable when fetch is aborted (timeout)", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof globalThis.fetch;
    vi.useFakeTimers();
    const promise = verifyApiKey(BASE, "abc");
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;
    vi.useRealTimers();
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("simpro_unreachable");
  });
});

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

  it("returns granted:false when fetch is aborted (timeout)", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof globalThis.fetch;
    vi.useFakeTimers();
    const promise = probeCompany(BASE, "key", "4");
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;
    vi.useRealTimers();
    expect(result.granted).toBe(false);
  });
});
