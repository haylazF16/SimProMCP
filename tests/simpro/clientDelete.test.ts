import { describe, it, expect } from "vitest";
import { SimproClient } from "../../src/simpro/client.js";
import type { Config } from "../../src/config.js";

const cfg = {
  SIMPRO_BASE_URL: "https://x.simprosuite.com",
  SIMPRO_API_KEY: "key12345",
  SIMPRO_COMPANY_ID: "4",
  SIMPRO_REQUEST_TIMEOUT_MS: 1000,
} as unknown as Config;

describe("SimproClient.del", () => {
  it("issues a DELETE request (non-retryable) via the core request path", async () => {
    const client = new SimproClient(cfg);
    const methods: string[] = [];
    // Shadow the private doFetch on this instance to capture the verb.
    (client as unknown as { doFetch: (m: string) => Promise<unknown> }).doFetch =
      async (m: string) => { methods.push(m); return {}; };
    await client.del("/companies/4/jobs/1/attachments/files/9");
    expect(methods).toEqual(["DELETE"]);
  });
});
