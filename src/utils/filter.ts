// Simpro v1.0 list endpoints filter by COLUMN NAME with SQL-like %wildcards%.
// A `?keyword=...` parameter is silently ignored.
//
// Verified empirically against Goldman Plumbing's tenant (Simpro v26.2.3):
//   /customers/?CompanyName=%25GOLDMAN%25  -> works (substring match)
//   /customers/?keyword=GOLDMAN            -> ignored, returns unfiltered
//
// This helper turns a free-text user query into wildcard filters against
// the most useful column for each resource. If a tenant prefers different
// columns, adjust the `keywordColumns` argument at call sites.

import { Query } from "../simpro/client.js";

/** Wrap value with `%...%` for Simpro substring matching (URL encoder applied later). */
export function likeWildcard(value: string): string {
  return `%${value}%`;
}

/**
 * Build a query object that searches `keyword` against the first column
 * (Simpro endpoints don't OR across columns in one request — pick the best
 * default per resource and let the caller use a more specific filter via
 * rawPayload-style tools if needed).
 */
export function buildKeywordFilter(
  keyword: string | undefined,
  primaryColumn: string,
): Query {
  if (!keyword) return {};
  return { [primaryColumn]: likeWildcard(keyword) };
}
