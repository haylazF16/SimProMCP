// src/http/enroll.ts
// Orchestrators that tie the Simpro probes (src/simpro/probe.ts) and the
// tokens.json CRUD (src/http/tokens.ts) together. Used by the consent page
// (self-service enrollment) and the admin dashboard (manual enrollment).

import { verifyApiKey, probeCompany } from "../simpro/probe.js";
import {
  addUserIfAbsent,
  lookupBySimproKey,
  removeUser,
  type CompanyKey,
  type TokenRecord,
  COMPANY_IDS,
} from "./tokens.js";

/**
 * Probe Simpro for both companies in parallel and return which the key
 * has access to. Shared by enrollUser and probeForFrontend.
 */
async function detectCompanyAccess(simproBaseUrl: string, simproApiKey: string): Promise<CompanyKey[]> {
  const [plumbing, energy] = await Promise.all([
    probeCompany(simproBaseUrl, simproApiKey, COMPANY_IDS.plumbing),
    probeCompany(simproBaseUrl, simproApiKey, COMPANY_IDS.energy),
  ]);
  const out: CompanyKey[] = [];
  if (plumbing.granted) out.push("plumbing");
  if (energy.granted) out.push("energy");
  return out;
}

export type EnrollReason =
  | "invalid_key"
  | "simpro_unreachable"
  | "no_company_access"
  | "name_required"
  | "unexpected_status";

export interface EnrollSuccess {
  ok: true;
  smcpToken: string;
  record: TokenRecord;
  wasIdempotent: boolean;
}
export interface EnrollFailure {
  ok: false;
  reason: EnrollReason;
}
export type EnrollResult = EnrollSuccess | EnrollFailure;

export interface EnrollInput {
  tokensFile: string;
  simproBaseUrl: string;
  simproApiKey: string;
  submittedName: string;
  /** "self-service" (default) or "manual" — used to set enrolledVia on the record. */
  via?: "self-service" | "manual";
}

/**
 * The main onboarding orchestrator. Validates the Simpro key, detects
 * company access, and either returns an existing user's smcp_ token
 * (idempotent re-enrollment) or creates a brand new record.
 */
export async function enrollUser(input: EnrollInput): Promise<EnrollResult> {
  const name = input.submittedName.trim();
  if (!name) return { ok: false, reason: "name_required" };

  // 1. Validate the key against Simpro /info
  const verify = await verifyApiKey(input.simproBaseUrl, input.simproApiKey);
  if (!verify.valid) {
    return { ok: false, reason: verify.reason ?? "unexpected_status" };
  }

  // 2. Detect company access (both companies probed in parallel)
  const companyAccess = await detectCompanyAccess(input.simproBaseUrl, input.simproApiKey);
  if (companyAccess.length === 0) {
    return { ok: false, reason: "no_company_access" };
  }

  // 3. Atomic idempotent create-or-find (handles concurrent enroll with same key).
  const result = await addUserIfAbsent(input.tokensFile, {
    name,
    simproApiKey: input.simproApiKey,
    companyAccess,
    writeEnabled: true,
    enrolledVia: input.via ?? "self-service",
  });
  return {
    ok: true,
    smcpToken: result.smcpToken,
    record: result.record,
    wasIdempotent: !result.wasAbsent,
  };
}

export interface UnenrollInput {
  tokensFile: string;
  simproBaseUrl: string;
  simproApiKey: string;
}

export type UnenrollResult =
  | { ok: true; removed: boolean }
  | { ok: false; reason: EnrollReason };

/**
 * Self-service removal. Requires a still-valid Simpro key as proof of ownership.
 * Returns {ok:true,removed:false} silently when no matching record — don't leak
 * who is or isn't enrolled.
 */
export async function unenrollUser(input: UnenrollInput): Promise<UnenrollResult> {
  const verify = await verifyApiKey(input.simproBaseUrl, input.simproApiKey);
  if (!verify.valid) {
    return { ok: false, reason: verify.reason ?? "unexpected_status" };
  }
  const existing = lookupBySimproKey(input.tokensFile, input.simproApiKey);
  if (!existing) return { ok: true, removed: false };
  const removed = await removeUser(input.tokensFile, existing.smcpToken);
  return { ok: true, removed };
}

export interface ProbeFrontendInput {
  simproBaseUrl: string;
  simproApiKey: string;
}

export type ProbeFrontendResult =
  | { valid: true; name: string | null; companyAccess: CompanyKey[] }
  | { valid: false; reason: EnrollReason };

/**
 * Live-probe used by the consent page's AJAX call. Same validation as
 * enrollUser steps 1-2, but doesn't touch tokens.json.
 */
export async function probeForFrontend(input: ProbeFrontendInput): Promise<ProbeFrontendResult> {
  const verify = await verifyApiKey(input.simproBaseUrl, input.simproApiKey);
  if (!verify.valid) {
    return { valid: false, reason: verify.reason ?? "unexpected_status" };
  }
  const companyAccess = await detectCompanyAccess(input.simproBaseUrl, input.simproApiKey);
  return { valid: true, name: verify.name, companyAccess };
}
