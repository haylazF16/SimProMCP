import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

const SNAPSHOT = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SNAPSHOT)) delete process.env[k];
  Object.assign(process.env, SNAPSHOT);
});

function baseEnv() {
  process.env.SIMPRO_TRANSPORT = "http";
  process.env.SIMPRO_BASE_URL = "https://x.simprosuite.com";
  process.env.SIMPRO_COMPANY_ID = "4";
}

describe("attachment config", () => {
  it("defaults SIMPRO_MAX_ATTACHMENT_MB to 20 and SIMPRO_STAGING_DIR to ./staging", () => {
    baseEnv();
    delete process.env.SIMPRO_MAX_ATTACHMENT_MB;
    delete process.env.SIMPRO_STAGING_DIR;
    const cfg = loadConfig();
    expect(cfg.SIMPRO_MAX_ATTACHMENT_MB).toBe(20);
    expect(cfg.SIMPRO_STAGING_DIR).toBe("./staging");
  });

  it("parses SIMPRO_MAX_ATTACHMENT_MB from a string env var", () => {
    baseEnv();
    process.env.SIMPRO_MAX_ATTACHMENT_MB = "50";
    expect(loadConfig().SIMPRO_MAX_ATTACHMENT_MB).toBe(50);
  });
});
