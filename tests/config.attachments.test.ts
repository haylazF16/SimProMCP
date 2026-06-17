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

  it("defaults SIMPRO_DOWNLOAD_DIR to ./downloads", () => {
    baseEnv();
    delete process.env.SIMPRO_DOWNLOAD_DIR;
    expect(loadConfig().SIMPRO_DOWNLOAD_DIR).toBe("./downloads");
  });

  it("honours an explicit SIMPRO_DOWNLOAD_DIR", () => {
    baseEnv();
    process.env.SIMPRO_DOWNLOAD_DIR = "/var/lib/simpro-mcp/downloads";
    expect(loadConfig().SIMPRO_DOWNLOAD_DIR).toBe("/var/lib/simpro-mcp/downloads");
  });

  it("throws (does not clamp) for an out-of-range or non-numeric SIMPRO_MAX_ATTACHMENT_MB", () => {
    for (const bad of ["0", "999", "abc"]) {
      baseEnv();
      process.env.SIMPRO_MAX_ATTACHMENT_MB = bad;
      expect(() => loadConfig(), `expected loadConfig() to throw for "${bad}"`).toThrow(
        /configuration is invalid/i,
      );
    }
  });
});
