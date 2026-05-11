// src/http/enroll.ts
// Orchestrators that tie the Simpro probes (src/simpro/probe.ts) and the
// tokens.json CRUD (src/http/tokens.ts) together. Used by the consent page
// (self-service enrollment) and the admin dashboard (manual enrollment).

import { verifyApiKey, probeCompany } from "../simpro/probe.js";
import {
  addUser,
  lookupBySimproKey,
  removeUser,
  type CompanyKey,
  type TokenRecord,
  COMPANY_IDS,
} from "./tokens.js";

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

  // 2. Detect company access (both companies probed)
  const companyAccess: CompanyKey[] = [];
  const plumbing = await probeCompany(input.simproBaseUrl, input.simproApiKey, COMPANY_IDS.plumbing);
  if (plumbing.granted) companyAccess.push("plumbing");
  const energy = await probeCompany(input.simproBaseUrl, input.simproApiKey, COMPANY_IDS.energy);
  if (energy.granted) companyAccess.push("energy");
  if (companyAccess.length === 0) {
    return { ok: false, reason: "no_company_access" };
  }

  // 3. Idempotent: return existing record if we've seen this Simpro key
  const existing = lookupBySimproKey(input.tokensFile, input.simproApiKey);
  if (existing) {
    return {
      ok: true,
      smcpToken: existing.smcpToken,
      record: existing.record,
      wasIdempotent: true,
    };
  }

  // 4. Create new record. writeEnabled defaults true per spec section 3.
  const created = await addUser(input.tokensFile, {
    name,
    simproApiKey: input.simproApiKey,
    companyAccess,
    writeEnabled: true,
    enrolledVia: input.via ?? "self-service",
  });
  return {
    ok: true,
    smcpToken: created.smcpToken,
    record: created.record,
    wasIdempotent: false,
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
  const companyAccess: CompanyKey[] = [];
  const plumbing = await probeCompany(input.simproBaseUrl, input.simproApiKey, COMPANY_IDS.plumbing);
  if (plumbing.granted) companyAccess.push("plumbing");
  const energy = await probeCompany(input.simproBaseUrl, input.simproApiKey, COMPANY_IDS.energy);
  if (energy.granted) companyAccess.push("energy");
  return { valid: true, name: verify.name, companyAccess };
}
