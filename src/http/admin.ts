// src/http/admin.ts
// Admin dashboard for managing enrolled users.
// All routes are gated by requireAdmin which checks the smcp_ token's
// isAdmin flag in tokens.json.

import { type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { authenticate } from "./tokens.js";

/**
 * Middleware factory: returns a handler that 401s unauthenticated requests,
 * 403s authenticated-but-non-admin requests, and only lets through requests
 * from tokens whose record has isAdmin=true.
 *
 * The tokens file path is bound at app-setup time so each app can use its own
 * (handy in tests).
 */
export function requireAdmin(tokensFile: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = authenticate(tokensFile, req.headers["authorization"]);
    if (!auth.ok) {
      res.status(auth.status).type("text/plain").send(auth.reason);
      return;
    }
    if (auth.record.isAdmin !== true) {
      res.status(403).type("text/plain").send("Admin access required.");
      return;
    }
    (res.locals as { admin: { name: string; smcpToken: string } }).admin = {
      name: auth.record.name,
      smcpToken: auth.token,
    };
    next();
  };
}
