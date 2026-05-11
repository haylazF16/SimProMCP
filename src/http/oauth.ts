// OAuth 2.0 server-side implementation for the Simpro MCP server.
//
// Why we need this: Claude Desktop's "Custom Connector" feature does not use
// static bearer tokens directly — it requires the MCP server to implement
// the OAuth 2.1 authorization flow (Authorization Code with PKCE +
// Dynamic Client Registration), per the MCP Authorization spec.
//
// Our pragmatic implementation:
//   - The user already has a bearer token (smcp_xxx) created by add-user.sh
//   - We use that same token AS the OAuth access_token (no separate token
//     issuance — the user's bearer IS the access_token)
//   - The /authorize step shows a small consent page where the user
//     pastes their bearer to prove identity (one-time per Claude Desktop
//     install, then it sticks)
//   - /token exchanges the auth code for the same bearer
//   - Subsequent MCP requests authenticate with `Authorization: Bearer <smcp_xxx>`
//   - verifyAccessToken() looks up the bearer in tokens.json
//
// Result: Claude Desktop's OAuth flow completes successfully, but no
// real account/login system is needed — the bearer token is the credential.

import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Request, Response, Router } from "express";
import {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { authenticate } from "./tokens.js";
import { log } from "../logger.js";
import { probeForFrontend, enrollUser } from "./enroll.js";
import { Config } from "../config.js";

// ---------------------------------------------------------------------------
// In-memory clients store. Claude Desktop registers itself dynamically; we
// accept any client. There's no need to persist client registrations across
// restarts because Claude Desktop re-registers when needed.
// ---------------------------------------------------------------------------

class GoldmanClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    this.clients.set(client.client_id, client);
    log.info(`OAuth client registered: ${client.client_id} (${client.client_name ?? "unnamed"})`);
    return client;
  }
}

// ---------------------------------------------------------------------------
// In-memory auth code store. Each authorization code is one-time-use, maps
// to (client, requested params, the user's bearer token). Codes expire
// after 10 min.
// ---------------------------------------------------------------------------

interface AuthCodeRecord {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  userToken: string; // The smcp_xxx bearer
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// The provider implementation
// ---------------------------------------------------------------------------

export class GoldmanOAuthProvider implements OAuthServerProvider {
  public readonly clientsStore = new GoldmanClientsStore();
  private codes = new Map<string, AuthCodeRecord>();
  // Pending authorization requests, keyed by a session ID we put in a cookie.
  // When the user comes back from the consent page, we look up the original
  // OAuth params here.
  private pendingAuth = new Map<
    string,
    {
      client: OAuthClientInformationFull;
      params: AuthorizationParams;
      expiresAt: number;
    }
  >();

  constructor(private readonly tokensFile: string) {}

  /**
   * Called by the SDK's /authorize handler. We need to either:
   *   - Issue a code and redirect (if the user is already authenticated), or
   *   - Show a consent UI for them to authenticate, then come back here
   *
   * The router's `authorize` handler doesn't pass us the express Request, only
   * Response. So we can't read cookies here. We work around this by NOT using
   * the SDK's /authorize handler directly — instead we register our own
   * /authorize and /authorize/consent routes (see attachOAuthRoutes below)
   * and call this method internally only when the user has authenticated.
   *
   * The router's other handlers (token, register, discovery) we DO use.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // This is called only after we've authenticated the user out-of-band.
    // The userToken is set on res.locals by our consent handler before
    // calling this.
    const userToken = (res.locals as { userToken?: string }).userToken;
    if (!userToken) {
      throw new Error("authorize() called without an authenticated user — this is a bug");
    }

    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      client,
      params,
      userToken,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
    });

    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new Error(`Unregistered redirect_uri: ${params.redirectUri}`);
    }

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) target.searchParams.set("state", params.state);
    log.info(`OAuth code issued for client ${client.client_id}, redirecting to ${target.host}`);
    res.redirect(target.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const data = this.codes.get(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    log.info(`[oauth] exchangeAuthorizationCode called by client=${client.client_id} code=${authorizationCode.slice(0, 8)}...`);
    const data = this.codes.get(authorizationCode);
    if (!data) {
      log.warn(`[oauth] exchange FAILED: invalid/unknown code ${authorizationCode.slice(0, 8)}...`);
      throw new Error("Invalid authorization code");
    }
    if (Date.now() > data.expiresAt) {
      this.codes.delete(authorizationCode);
      log.warn(`[oauth] exchange FAILED: code expired`);
      throw new Error("Authorization code expired");
    }
    if (data.client.client_id !== client.client_id) {
      log.warn(`[oauth] exchange FAILED: client mismatch (issued to ${data.client.client_id}, presented by ${client.client_id})`);
      throw new Error("Code was not issued to this client");
    }
    // PKCE: the SDK's /token handler MAY validate the verifier itself before
    // delegating, but the spec requires the auth server enforce it — and we
    // can't be certain across SDK versions. Defence-in-depth: validate here
    // too. Without this, an attacker who steals an authorization code from
    // a redirect log/header can exchange it without the verifier.
    if (!codeVerifier) {
      log.warn(`[oauth] exchange FAILED: missing PKCE code_verifier`);
      throw new Error("Missing PKCE code_verifier");
    }
    if (!verifyPkce(codeVerifier, data.params.codeChallenge)) {
      log.warn(`[oauth] exchange FAILED: PKCE verification failed`);
      throw new Error("PKCE verification failed");
    }

    // Single-use: delete after exchange
    this.codes.delete(authorizationCode);
    log.info(`[oauth] exchange OK -> issuing access_token (smcp_*** masked) for client=${client.client_id}`);

    // The access token is the user's existing bearer token. No expiration
    // on our side — bearer is rotated by add-user.sh / revoke-user.sh.
    return {
      access_token: data.userToken,
      token_type: "Bearer",
      // No refresh_token issued; if access_token is revoked the user
      // re-runs the OAuth flow (Claude Desktop will re-prompt automatically).
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error("Refresh tokens are not supported. Re-authorize via /authorize.");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // The access_token IS one of our smcp_xxx bearer tokens.
    const auth = authenticate(this.tokensFile, `Bearer ${token}`);
    if (!auth.ok) {
      throw new Error(auth.reason);
    }
    return {
      token,
      clientId: "claude-desktop",
      scopes: [],
      // Pass the user record through so the downstream MCP handler can use it.
      extra: {
        userName: auth.record.name,
        simproApiKey: auth.record.simproApiKey,
        companyAccess: auth.record.companyAccess,
        writeEnabled: auth.record.writeEnabled === true,
      },
    };
  }

  // ---- consent flow helpers (called from custom routes below) ----

  /**
   * Called by GET /authorize. Stores the pending OAuth request in memory
   * keyed by a session ID we put in a cookie, then returns the consent HTML.
   */
  beginPending(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
  ): string {
    const sessionId = randomUUID();
    this.pendingAuth.set(sessionId, {
      client,
      params,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return sessionId;
  }

  consumePending(sessionId: string): {
    client: OAuthClientInformationFull;
    params: AuthorizationParams;
  } | undefined {
    const data = this.pendingAuth.get(sessionId);
    if (!data) return undefined;
    if (Date.now() > data.expiresAt) {
      this.pendingAuth.delete(sessionId);
      return undefined;
    }
    this.pendingAuth.delete(sessionId);
    return data;
  }

}

// ---------------------------------------------------------------------------
// HTML for the consent page. Minimal, inline CSS, no JavaScript.
// ---------------------------------------------------------------------------

function consentPage(opts: {
  sessionId: string;
  clientName: string;
  errorMessage?: string;
  prefilledName?: string;
}): string {
  const { sessionId, clientName, errorMessage, prefilledName } = opts;
  const safeClient = clientName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 100);
  const errBlock = errorMessage
    ? `<div class="err">${errorMessage
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</div>`
    : "";
  const safePrefilledName = (prefilledName ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .slice(0, 100);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Goldman Simpro AI tool - authorize</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#0f4c75; color:#fff; margin:0; padding:0; min-height:100vh;
         display:flex; align-items:center; justify-content:center; }
  .card { background:#fff; color:#222; max-width:480px; width:90%;
          padding:32px; border-radius:8px; box-shadow:0 8px 32px rgba(0,0,0,0.2); }
  h1 { margin:0 0 8px; font-size:20px; color:#0f4c75; }
  .sub { color:#666; font-size:14px; margin-bottom:24px; }
  .client { background:#eef4fb; padding:8px 12px; border-radius:4px;
            font-size:13px; margin-bottom:16px; }
  label { display:block; margin:14px 0 6px; font-weight:600; font-size:14px; }
  input { width:100%; padding:10px; box-sizing:border-box;
          border:1px solid #ccc; border-radius:4px; font-size:14px; }
  input.simpro-key { font-family: monospace; }
  button { width:100%; padding:12px; background:#0f4c75; color:#fff;
           border:none; border-radius:4px; font-size:15px; font-weight:600;
           cursor:pointer; margin-top:16px; }
  button:hover { background:#1b5e9c; }
  button:disabled { background:#888; cursor:wait; }
  .err { background:#fff3f3; color:#c0392b; padding:10px; border-radius:4px;
         margin-bottom:16px; font-size:13px; border:1px solid #f0c4c0; }
  .info { background:#eaf6ea; color:#1c6b1c; padding:8px 10px;
          border-radius:4px; font-size:13px; margin-top:8px; min-height:18px; }
  .info.error { background:#fff3f3; color:#c0392b; }
  .info:empty { display:none; }
  .help { font-size:12px; color:#888; margin-top:16px; line-height:1.5; }
  .unenroll { font-size:12px; color:#888; margin-top:20px; text-align:center; }
  .unenroll a { color:#888; }
</style>
</head>
<body>
<div class="card">
  <h1>Goldman Simpro AI tool</h1>
  <div class="sub">Authorize this client to access Simpro on your behalf.</div>
  <div class="client">Client: <b>${safeClient}</b></div>
  ${errBlock}
  <form method="POST" action="/authorize/consent" id="enroll-form">
    <input type="hidden" name="session" value="${sessionId}">
    <label for="name">Your full name</label>
    <input type="text" id="name" name="name" autocomplete="name"
           value="${safePrefilledName}" required maxlength="100">
    <label for="simpro_key">Your Simpro API key</label>
    <input type="password" id="simpro_key" name="simpro_key"
           class="simpro-key" autocomplete="off"
           placeholder="paste your Simpro API key" required minlength="20" maxlength="200">
    <div id="probe-info" class="info"></div>
    <button type="submit" id="submit-btn">Authorize</button>
  </form>
  <div class="help">
    Paste the Simpro API key you created in Simpro (gear icon → System → Setup → API Keys).
    We validate it with Simpro and detect which companies (Plumbing, Energy)
    you have access to. After this one-time authorization, Claude Desktop
    will keep you signed in — you won't see this page again on this device.
  </div>
  <div class="unenroll"><a href="/unenroll">Remove my account</a></div>
</div>
<script>
(() => {
  const keyInput = document.getElementById("simpro_key");
  const nameInput = document.getElementById("name");
  const info = document.getElementById("probe-info");
  let timer = null;
  let lastProbed = "";

  function probe() {
    const k = keyInput.value.trim();
    if (k.length < 20 || k === lastProbed) return;
    lastProbed = k;
    info.classList.remove("error");
    info.textContent = "Checking with Simpro...";
    fetch("/enroll/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ simpro_key: k }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.valid) {
          if (!nameInput.value.trim() && data.name) nameInput.value = data.name;
          const access = (data.companyAccess || []).join(", ");
          info.textContent = "Verified. Access: " + (access || "none — see error");
          if (!access) info.classList.add("error");
        } else {
          info.classList.add("error");
          const reasons = {
            invalid_key: "Simpro rejected this key.",
            simpro_unreachable: "Couldn't reach Simpro — check your network.",
            no_company_access: "Key has no access to Plumbing or Energy.",
          };
          info.textContent = reasons[data.reason] || ("Validation failed: " + data.reason);
        }
      })
      .catch(() => {
        info.classList.add("error");
        info.textContent = "Probe failed.";
      });
  }

  keyInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(probe, 600);
  });
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Express routes — call this from server.ts.
// We attach our own /authorize + /authorize/consent routes in addition to
// the SDK's mcpAuthRouter (which provides /token, /register, /.well-known/*).
// ---------------------------------------------------------------------------

/**
 * Allowlist for redirect_uri hosts when lazy-registering an unknown client.
 *
 * Without this, a phishing flow becomes possible:
 *   /authorize?client_id=Anything&redirect_uri=https://evil.example/&...
 * Even though the consent gate stops issuance without a valid bearer, an
 * employee who pastes their bearer would have the resulting auth code
 * delivered to evil.example, which could then exchange it for the user's
 * smcp_ token (full account compromise — that token IS the credential).
 *
 * We accept:
 *   - https://claude.ai/* and https://*.claude.ai/* (Anthropic's callback)
 *   - http://localhost:* / http://127.0.0.1:* (dev / loopback callbacks)
 * Anything else is rejected with 400.
 */
function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") {
    return u.hostname === "claude.ai" || u.hostname.endsWith(".claude.ai");
  }
  if (u.protocol === "http:") {
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  }
  return false;
}

export function attachConsentRoutes(
  router: Router,
  provider: GoldmanOAuthProvider,
  config: Config,
): void {
  // Custom GET /authorize — overrides the SDK's. Renders the consent page.
  router.get("/authorize", async (req: Request, res: Response) => {
    try {
      const params = parseAuthorizeQuery(req);

      // Hard-block redirects to anywhere we don't recognise BEFORE we touch
      // the clients store or render the consent page. This is the single
      // most important defence against the lazy-DCR open-redirect class
      // of attack.
      if (!isAllowedRedirectUri(params.redirectUri)) {
        log.warn(`OAuth /authorize REJECTED: disallowed redirect_uri ${params.redirectUri}`);
        res.status(400).type("text/plain").send(
          "redirect_uri is not on the allowlist. Allowed: https://*.claude.ai, http://localhost:*, http://127.0.0.1:*.",
        );
        return;
      }

      let client = await provider.clientsStore.getClient(params.clientId);

      // Lazy Dynamic Client Registration: Claude Desktop's "Bearer token"
      // auth mode arrives at /authorize with a hardcoded client_id
      // ("Bearer token") and no preceding /register call. We auto-register
      // unknown clients ONLY if the redirect_uri passed the allowlist above.
      if (!client) {
        client = await provider.clientsStore.registerClient({
          client_id: params.clientId,
          client_name: params.clientId,
          redirect_uris: [params.redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        } as unknown as OAuthClientInformationFull);
        log.info(`OAuth client auto-registered (lazy DCR): ${params.clientId} -> ${params.redirectUri}`);
      } else if (!client.redirect_uris.includes(params.redirectUri)) {
        // Existing client showing up with a NEW redirect_uri. Only accept
        // if it's still on the host allowlist (already checked above) AND
        // is on the same host as a previously-registered redirect — this
        // prevents an attacker who learned a client_id from pivoting it
        // to a different (but still allowlisted) attacker-controlled host
        // under e.g. *.claude.ai. We compare hostnames only (ports/paths
        // can vary legitimately between Claude Desktop builds).
        const newHost = new URL(params.redirectUri).hostname;
        const knownHosts = new Set(
          client.redirect_uris.map((u) => {
            try { return new URL(u).hostname; } catch { return ""; }
          }),
        );
        if (!knownHosts.has(newHost)) {
          log.warn(
            `OAuth /authorize REJECTED: client ${params.clientId} previously used hosts ${[...knownHosts].join(",")}, refused new host ${newHost}`,
          );
          res.status(400).type("text/plain").send(
            "redirect_uri host does not match this client's previously-registered hosts.",
          );
          return;
        }
        client.redirect_uris = [...client.redirect_uris, params.redirectUri];
        await provider.clientsStore.registerClient(client);
        log.info(`OAuth client redirect_uri added: ${params.clientId} += ${params.redirectUri}`);
      }
      const sessionId = provider.beginPending(client, params);
      renderConsentResponse(res, {
        sessionId,
        clientName: client.client_name ?? client.client_id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).type("text/plain").send(`Authorize error: ${msg}`);
    }
  });

  // AJAX endpoint used by the consent page's live probe.
  router.post("/enroll/probe", async (req: Request, res: Response) => {
    const body = req.body as { simpro_key?: string };
    const key = typeof body?.simpro_key === "string" ? body.simpro_key.trim() : "";
    if (key.length < 20) {
      res.status(400).json({ valid: false, reason: "invalid_key" });
      return;
    }
    try {
      const result = await probeForFrontend({
        simproBaseUrl: config.SIMPRO_BASE_URL,
        simproApiKey: key,
      });
      res.json(result);
    } catch (err) {
      log.warn(`/enroll/probe error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ valid: false, reason: "simpro_unreachable" });
    }
  });

  router.post("/authorize/consent", async (req: Request, res: Response) => {
    const { session, name, simpro_key } = req.body as {
      session?: string;
      name?: string;
      simpro_key?: string;
    };
    if (!session || !name || !simpro_key) {
      res.status(400).type("text/plain").send("Missing fields");
      return;
    }
    const pending = provider.consumePending(session);
    if (!pending) {
      res.status(400).type("text/plain").send(
        "Authorization session expired or invalid — please go back to Claude Desktop and click Connect again.",
      );
      return;
    }

    // Run the enrollment orchestrator.
    const result = await enrollUser({
      tokensFile: config.SIMPRO_TOKENS_FILE,
      simproBaseUrl: config.SIMPRO_BASE_URL,
      simproApiKey: simpro_key.trim(),
      submittedName: name.trim(),
      via: "self-service",
    });

    if (!result.ok) {
      // Re-render the consent page with an inline error.
      const reasonMsg: Record<string, string> = {
        invalid_key: "Simpro rejected that API key. Double-check and try again.",
        simpro_unreachable: "Couldn't reach Simpro to verify the key. Wait a minute and retry. If it persists, contact Tayfun.",
        no_company_access: "Your Simpro key doesn't have access to Goldman Plumbing (company 4) or Goldman Energy (company 37). Ask Simpro IT to grant access.",
        name_required: "Please enter your full name.",
        unexpected_status: "Simpro returned an unexpected response. Try again.",
      };
      const newSessionId = provider.beginPending(pending.client, pending.params);
      renderConsentResponse(res, {
        sessionId: newSessionId,
        clientName: pending.client.client_name ?? pending.client.client_id,
        errorMessage: reasonMsg[result.reason] ?? `Error: ${result.reason}`,
        prefilledName: name.trim(),
      });
      return;
    }

    // Audit-log the enrollment outcome. Sanitize user-typed name to prevent
    // log injection (a name containing \n/\r could forge log lines).
    const safeName = oneLine(result.record.name);
    log.info(`enroll success: name=${safeName} companies=${result.record.companyAccess.join(",")} idempotent=${result.wasIdempotent}`);

    // Stash the issued smcp_ token on res.locals and complete the OAuth handshake.
    (res.locals as { userToken: string }).userToken = result.smcpToken;
    await provider.authorize(pending.client, pending.params, res);
  });
}

// ---------------------------------------------------------------------------
// Helper: parse the OAuth /authorize query parameters
// ---------------------------------------------------------------------------

function parseAuthorizeQuery(req: Request): AuthorizationParams & { clientId: string } {
  const q = req.query;
  const responseType = q.response_type;
  if (responseType !== "code") {
    throw new Error(`Unsupported response_type: ${responseType}`);
  }
  const clientId = oneStr(q.client_id);
  if (!clientId) throw new Error("Missing client_id");
  const redirectUri = oneStr(q.redirect_uri);
  if (!redirectUri) throw new Error("Missing redirect_uri");
  const codeChallenge = oneStr(q.code_challenge);
  if (!codeChallenge) throw new Error("Missing code_challenge (PKCE required)");
  const codeChallengeMethod = oneStr(q.code_challenge_method);
  if (codeChallengeMethod && codeChallengeMethod !== "S256") {
    throw new Error("Only code_challenge_method=S256 is supported");
  }
  return {
    clientId,
    redirectUri,
    codeChallenge,
    state: oneStr(q.state),
    scopes: oneStr(q.scope)?.split(" ").filter(Boolean),
    resource: q.resource ? new URL(oneStr(q.resource)!) : undefined,
  };
}

function oneStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

// ---------------------------------------------------------------------------
// PKCE S256 verification: SHA-256(code_verifier) (base64url, no padding) must
// equal the code_challenge stored at /authorize time. Called from
// exchangeAuthorizationCode for defence-in-depth on top of any SDK check.
// ---------------------------------------------------------------------------

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  return computed === codeChallenge;
}

// ---------------------------------------------------------------------------
// Shared consent-page renderer. Both the GET /authorize success path and the
// POST /authorize/consent error-rerender path go through here so the security
// headers (CSP, X-Frame-Options, Referrer-Policy) apply uniformly.
//
// CSP for the consent page. We allow:
//   - 'unsafe-inline' for <style> (inline CSS in the template)
//   - 'unsafe-inline' for <script> (inline JS for the live-probe AJAX)
//   - connect-src 'self' so the inline JS can fetch /enroll/probe
//   - form-action 'self' so the form POSTs to /authorize/consent
//   - frame-ancestors 'none' to block clickjacking
// The HTML is fully server-generated with proper escaping; no user content is
// interpolated into script context, so the script-src unsafe-inline relaxation
// doesn't open an XSS surface.
// ---------------------------------------------------------------------------

function renderConsentResponse(
  res: Response,
  opts: { sessionId: string; clientName: string; errorMessage?: string; prefilledName?: string },
): void {
  res
    .type("text/html")
    .set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
    )
    .set("X-Frame-Options", "DENY")
    .set("Referrer-Policy", "no-referrer")
    .send(consentPage(opts));
}

// Collapse newlines/tabs and cap length — used to sanitize user-typed values
// before they're embedded in log lines (log-injection prevention).
function oneLine(s: string): string {
  return s.replace(/[\r\n\t]/g, " ").slice(0, 100);
}
