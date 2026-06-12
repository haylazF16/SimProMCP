// tests/http/protectedResourceMetadata.test.ts
//
// Regression: Claude's connector client could not discover the auth server
// because the resource published no RFC 9728 metadata and the 401 carried no
// WWW-Authenticate header — the Connect flow looped on claude.com without
// reaching the Goldman consent page (observed 2026-06-12, after a Claude
// Desktop update tightened auth discovery). These helpers produce the two
// missing signals.

import { describe, it, expect } from "vitest";
import {
  buildProtectedResourceMetadata,
  protectedResourceMetadataUrl,
  wwwAuthenticateChallenge,
} from "../../src/http/oauth.js";

const ORIGIN = "https://goldman-ubuntu.tail6b5a4b.ts.net";

describe("protected resource metadata (RFC 9728)", () => {
  it("metadata names the resource and points at the issuer's AS", () => {
    const doc = buildProtectedResourceMetadata({
      issuerOrigin: ORIGIN,
      resourcePath: "/mcp/plumbing",
      resourceName: "Goldman Simpro MCP (Plumbing)",
    });
    expect(doc.resource).toBe(`${ORIGIN}/mcp/plumbing`);
    // Must match the issuer in /.well-known/oauth-authorization-server exactly
    // (trailing slash) so the client can chain to the AS metadata.
    expect(doc.authorization_servers).toEqual([`${ORIGIN}/`]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
    expect(doc.resource_name).toBe("Goldman Simpro MCP (Plumbing)");
  });

  it("metadata URL inserts the well-known prefix before the resource path", () => {
    expect(protectedResourceMetadataUrl(ORIGIN, "/mcp/energy")).toBe(
      `${ORIGIN}/.well-known/oauth-protected-resource/mcp/energy`,
    );
  });

  it("WWW-Authenticate challenge advertises the resource_metadata URL", () => {
    const url = protectedResourceMetadataUrl(ORIGIN, "/mcp/plumbing");
    const challenge = wwwAuthenticateChallenge(url, "Missing Authorization header");
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(`resource_metadata="${url}"`);
    // The reason is interpolated — must not break the header with quotes/CRLF.
    expect(challenge).not.toMatch(/[\r\n]/);
  });

  it("WWW-Authenticate sanitises quotes/newlines in the reason", () => {
    const challenge = wwwAuthenticateChallenge("https://x/y", 'bad"\r\ninjection');
    expect(challenge).not.toContain('"bad"');
    expect(challenge).not.toMatch(/[\r\n]/);
  });
});
