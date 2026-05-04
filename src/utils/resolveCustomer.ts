// Helper used by search_jobs / search_quotes / search_invoices to convert
// a free-text customer name into a Simpro customer ID. Without this, an LLM
// asking "find quotes for Northern Sydney" mistakenly puts the name in the
// `query` field, which only filters against the resource's own Description
// column — and Simpro's quote/job descriptions don't contain customer names.

import { SimproClient } from "../simpro/client.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { extractList } from "../tools/_shared.js";
import { likeWildcard } from "./filter.js";

export interface CustomerResolution {
  /** Single best match. Undefined if zero or ambiguous. */
  matchedId?: number;
  /** All candidates surfaced (capped). */
  candidates: { ID: number; Type?: string; CompanyName?: string }[];
  /** Human-readable note for inclusion in tool output. */
  note: string;
}

/**
 * Look up customers whose CompanyName matches the supplied name (substring,
 * case-insensitive in Simpro). If exactly one matches, return its ID. If
 * many match, return the list so the caller can ask the user to disambiguate.
 */
export async function resolveCustomerByName(
  client: SimproClient,
  name: string,
  maxCandidates = 10,
): Promise<CustomerResolution> {
  const path = client.companyPath(ENDPOINTS.customers);
  const resp = await client.get<unknown>(path, {
    page: 1,
    pageSize: maxCandidates,
    CompanyName: likeWildcard(name),
  });
  const candidates = (extractList(resp) as { ID?: number; Type?: string; CompanyName?: string }[])
    .filter((c) => typeof c.ID === "number")
    .map((c) => ({ ID: c.ID as number, Type: c.Type, CompanyName: c.CompanyName }));

  if (candidates.length === 0) {
    return {
      candidates: [],
      note: `No customer found with a name containing "${name}".`,
    };
  }
  if (candidates.length === 1) {
    return {
      matchedId: candidates[0].ID,
      candidates,
      note: `Resolved customer name "${name}" → #${candidates[0].ID} ${candidates[0].CompanyName ?? ""}`,
    };
  }
  return {
    candidates,
    note:
      `Multiple customers match "${name}" — please re-run with a specific customerId. Candidates:\n` +
      candidates.map((c) => `  - #${c.ID} ${c.CompanyName ?? ""}${c.Type ? ` [${c.Type}]` : ""}`).join("\n"),
  };
}
