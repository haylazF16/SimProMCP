// tests/http/tokenExchange.test.ts
//
// Regression: the OAuth /token exchange returned 500 on EVERY fresh connection
// (observed 2026-06-12). SDK 1.29's token router validates PKCE itself (via
// challengeForAuthorizationCode + verifyChallenge) and then calls
// exchangeAuthorizationCode with codeVerifier=undefined. The provider's
// "defense-in-depth" check required codeVerifier and threw "Missing PKCE
// code_verifier", so no client could ever complete the handshake. PKCE stays
// enforced upstream by the SDK; this test pins that the provider accepts the
// SDK's undefined-verifier call and returns the user's token.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GoldmanOAuthProvider } from "../../src/http/oauth.js";

let dir: string;
let tokensFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "simpro-tok-"));
  tokensFile = path.join(dir, "tokens.json");
  fs.writeFileSync(tokensFile, JSON.stringify({ tokens: {} }), "utf8");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function mockRes(userToken: string) {
  const res = {
    locals: { userToken },
    redirectedTo: "",
    redirect(url: string) {
      this.redirectedTo = url;
    },
  };
  return res;
}

// Mirrors exactly how the SDK 1.29 token router drives the provider:
// challengeForAuthorizationCode() for PKCE, then exchange with NO verifier.
async function issueCodeAndExchange(provider: GoldmanOAuthProvider) {
  const client = {
    client_id: "client-1",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  } as unknown as Parameters<GoldmanOAuthProvider["authorize"]>[0];
  const params = {
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: "the-stored-challenge",
    state: "xyz",
  } as unknown as Parameters<GoldmanOAuthProvider["authorize"]>[1];

  const res = mockRes("smcp_tayfun_token");
  await provider.authorize(client, params, res as never);
  const code = new URL(res.redirectedTo).searchParams.get("code")!;

  // SDK validates PKCE using this, then calls exchange with undefined verifier.
  const challenge = await provider.challengeForAuthorizationCode(client, code);
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined);
  return { challenge, tokens };
}

describe("OAuth token exchange (SDK-driven PKCE)", () => {
  it("challengeForAuthorizationCode returns the stored code_challenge", async () => {
    const provider = new GoldmanOAuthProvider(tokensFile);
    const { challenge } = await issueCodeAndExchange(provider);
    expect(challenge).toBe("the-stored-challenge");
  });

  it("exchangeAuthorizationCode succeeds with codeVerifier=undefined (SDK already validated PKCE)", async () => {
    const provider = new GoldmanOAuthProvider(tokensFile);
    const { tokens } = await issueCodeAndExchange(provider);
    expect(tokens.access_token).toBe("smcp_tayfun_token");
    expect(tokens.token_type).toBe("Bearer");
  });

  it("authorization codes are single-use", async () => {
    const provider = new GoldmanOAuthProvider(tokensFile);
    const client = {
      client_id: "client-1",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    } as unknown as Parameters<GoldmanOAuthProvider["authorize"]>[0];
    const params = {
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: "c",
    } as unknown as Parameters<GoldmanOAuthProvider["authorize"]>[1];
    const res = mockRes("smcp_tayfun_token");
    await provider.authorize(client, params, res as never);
    const code = new URL(res.redirectedTo).searchParams.get("code")!;

    await provider.exchangeAuthorizationCode(client, code, undefined);
    // Second exchange of the same code must fail (already consumed).
    await expect(provider.exchangeAuthorizationCode(client, code, undefined)).rejects.toThrow();
  });
});
