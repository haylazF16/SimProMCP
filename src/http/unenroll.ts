// src/http/unenroll.ts
// Self-service "remove my account" routes. Authenticates by re-presenting
// the Simpro API key, which proves ownership and confirms the key is still
// valid (so a leaked-but-revoked key can't be used to wipe a record).

import { Router, type Request, type Response } from "express";
import { Config } from "../config.js";
import { log } from "../logger.js";
import { unenrollUser } from "./enroll.js";

export function attachUnenrollRoutes(router: Router, config: Config): void {
  router.get("/unenroll", (_req, res) => {
    sendHtml(res, unenrollPage({}));
  });

  router.post("/unenroll", async (req: Request, res: Response) => {
    const body = req.body as { simpro_key?: string };
    const key = typeof body?.simpro_key === "string" ? body.simpro_key.trim() : "";
    if (key.length < 20) {
      sendHtml(res, unenrollPage({ errorMessage: "Please paste a valid Simpro API key." }));
      return;
    }
    const result = await unenrollUser({
      tokensFile: config.SIMPRO_TOKENS_FILE,
      simproBaseUrl: config.SIMPRO_BASE_URL,
      simproApiKey: key,
    });
    if (!result.ok) {
      const reasonMsg: Record<string, string> = {
        invalid_key: "That Simpro key isn't valid. Make sure you're using a current key.",
        simpro_unreachable: "Couldn't reach Simpro to verify the key. Try again.",
        unexpected_status: "Unexpected response from Simpro. Try again.",
      };
      sendHtml(res, unenrollPage({
        errorMessage: reasonMsg[result.reason] ?? `Error: ${result.reason}`,
      }));
      return;
    }
    log.info(`unenroll outcome=${result.removed ? "removed" : "no_match"}`);
    sendHtml(res, unenrollResultPage(result.removed));
  });
}

function unenrollPage(opts: { errorMessage?: string }): string {
  const err = opts.errorMessage
    ? `<div class="err">${escapeHtml(opts.errorMessage)}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Remove my account - Goldman Simpro AI tool</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#0f4c75; color:#fff; margin:0; padding:0; min-height:100vh;
         display:flex; align-items:center; justify-content:center; }
  .card { background:#fff; color:#222; max-width:480px; width:90%;
          padding:32px; border-radius:8px; }
  h1 { margin:0 0 8px; font-size:20px; color:#0f4c75; }
  .sub { color:#666; font-size:14px; margin-bottom:24px; }
  label { display:block; margin:14px 0 6px; font-weight:600; font-size:14px; }
  input { width:100%; padding:10px; box-sizing:border-box;
          border:1px solid #ccc; border-radius:4px; font-size:14px;
          font-family: monospace; }
  button { width:100%; padding:12px; background:#c0392b; color:#fff;
           border:none; border-radius:4px; font-size:15px; font-weight:600;
           cursor:pointer; margin-top:16px; }
  .err { background:#fff3f3; color:#c0392b; padding:10px; border-radius:4px;
         margin-bottom:16px; font-size:13px; }
  .help { font-size:12px; color:#888; margin-top:16px; line-height:1.5; }
</style>
</head>
<body>
<div class="card">
  <h1>Remove my Goldman Simpro AI account</h1>
  <div class="sub">This deletes your access token. You can re-enroll any time
  with the same Simpro key.</div>
  ${err}
  <form method="POST" action="/unenroll">
    <label for="simpro_key">Your current Simpro API key</label>
    <input type="password" id="simpro_key" name="simpro_key" required minlength="20" maxlength="200">
    <button type="submit">Remove my account</button>
  </form>
  <div class="help">
    We re-verify the key with Simpro to prove it's still yours.
    A revoked or expired Simpro key won't work — get a fresh one if needed.
  </div>
</div>
</body>
</html>`;
}

function unenrollResultPage(removed: boolean): string {
  const msg = removed
    ? "Your account has been removed. Your Claude Desktop connector will stop working until you re-enroll."
    : "No account found for that Simpro key. Nothing to remove.";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Done</title>
<style>
  body { font-family: -apple-system, sans-serif; background:#0f4c75; color:#fff;
         min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { background:#fff; color:#222; max-width:480px; padding:32px; border-radius:8px; }
  h1 { color:#0f4c75; margin:0 0 12px; }
</style></head><body><div class="card">
<h1>Done</h1><p>${msg}</p>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send an HTML response with the standard security headers for self-service
 * pages. Used by both GET and POST render paths so protections don't depend
 * on the entry point.
 */
function sendHtml(res: Response, html: string): void {
  res
    .type("text/html")
    .set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    )
    .set("X-Frame-Options", "DENY")
    .set("Referrer-Policy", "no-referrer")
    .send(html);
}
