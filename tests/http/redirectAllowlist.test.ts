// tests/http/redirectAllowlist.test.ts
//
// Regression: the OAuth redirect_uri allowlist accepted only claude.ai.
// Anthropic's connector docs explicitly instruct servers to ALSO allowlist
// https://claude.com/api/mcp/auth_callback ("this callback URL may change to
// claude.com ... please allowlist [it] as well"). Claude Desktop's Connect
// flow dead-ended on Claude's website because /authorize 400-rejected the
// claude.com callback before the consent page could render (observed
// 2026-06-10).

import { describe, it, expect } from "vitest";
import { isAllowedRedirectUri } from "../../src/http/oauth.js";

describe("isAllowedRedirectUri", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://app.claude.ai/callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://app.claude.com/callback",
    "http://localhost:3334/cb",
    "http://127.0.0.1:8976/cb",
  ])("allows %s", (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(true);
  });

  it.each([
    "https://evil.example/cb",
    // Suffix-spoof attempts: hostname merely CONTAINING the allowed domain.
    "https://claude.ai.evil.example/cb",
    "https://claude.com.evil.example/cb",
    "https://notclaude.com/cb",
    // Allowed hosts but wrong scheme (https required for non-loopback).
    "http://claude.ai/api/mcp/auth_callback",
    "http://claude.com/api/mcp/auth_callback",
    // Loopback names are http-only territory; https loopback stays out.
    "ftp://claude.ai/cb",
    "not a url",
  ])("rejects %s", (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false);
  });
});
