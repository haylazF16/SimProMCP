// src/simpro/probe.ts
// Low-level Simpro REST probes used during enrollment.
// These exist as standalone functions (not on SimproClient) because we call
// them BEFORE the caller has a verified API key — there's no Config to bind
// a SimproClient to yet.

const FETCH_TIMEOUT_MS = 10_000;

export interface VerifyResult {
  valid: boolean;
  /** Employee name if Simpro returned one. */
  name: string | null;
  /** Set when valid=false. */
  reason?: "invalid_key" | "simpro_unreachable" | "unexpected_status";
}

/**
 * Probe Simpro's /info endpoint with the candidate API key to verify the key
 * is real and (best-effort) extract the linked employee's name.
 *
 * Returns valid=true on 2xx. Treats 401/403 as invalid_key. Network errors map
 * to simpro_unreachable so the UI can show "try again."
 */
export async function verifyApiKey(baseUrl: string, apiKey: string): Promise<VerifyResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1.0/info/`;
  let res: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
  } catch {
    return { valid: false, name: null, reason: "simpro_unreachable" };
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 || res.status === 403) {
    return { valid: false, name: null, reason: "invalid_key" };
  }
  if (res.status < 200 || res.status >= 300) {
    return { valid: false, name: null, reason: "unexpected_status" };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Body wasn't JSON — Simpro returned 200 but garbage. Treat as valid
    // (the key works) but no name extracted.
    return { valid: true, name: null };
  }

  return { valid: true, name: extractEmployeeName(body) };
}

/**
 * Best-effort extraction of an employee name from /info response.
 * Simpro tenants vary; we look at the common shapes. Returns null if none match.
 */
function extractEmployeeName(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  // Common shapes Simpro has returned over different API versions:
  //   { EmployeeName: "Tayfun Isik" }
  //   { Employee: { GivenName, FamilyName } }
  //   { LinkedEmployee: { Name: "..." } }
  if (typeof b.EmployeeName === "string" && b.EmployeeName.trim()) return b.EmployeeName.trim();
  const emp = b.Employee as Record<string, unknown> | undefined;
  if (emp) {
    const given = typeof emp.GivenName === "string" ? emp.GivenName : "";
    const family = typeof emp.FamilyName === "string" ? emp.FamilyName : "";
    const combined = `${given} ${family}`.trim();
    if (combined) return combined;
  }
  const linked = b.LinkedEmployee as Record<string, unknown> | undefined;
  if (linked && typeof linked.Name === "string" && linked.Name.trim()) return linked.Name.trim();
  return null;
}

export interface ProbeCompanyResult {
  granted: boolean;
}

/**
 * Probe a company-scoped endpoint to verify the API key has access to it.
 * We hit /jobs/?pageSize=1 because it's documented, cheap, and exists for
 * every company tenant. 2xx = granted; anything else (incl. network error)
 * = not granted.
 */
export async function probeCompany(baseUrl: string, apiKey: string, companyId: string): Promise<ProbeCompanyResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1.0/companies/${encodeURIComponent(companyId)}/jobs/?pageSize=1`;
  let res: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
  } catch {
    return { granted: false };
  } finally {
    clearTimeout(timeout);
  }
  return { granted: res.status >= 200 && res.status < 300 };
}
