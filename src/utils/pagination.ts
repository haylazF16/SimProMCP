import { Config } from "../config.js";
import { Query } from "../simpro/client.js";

export interface PageInfo {
  page: number;
  pageSize: number;
  query: Query;
}

/** Translate page/pageSize into Simpro's expected query params, clamped to limits. */
export function paginationQuery(cfg: Config, page?: number, pageSize?: number): PageInfo {
  const effectiveSize = Math.min(
    pageSize ?? cfg.SIMPRO_DEFAULT_PAGE_SIZE,
    cfg.SIMPRO_MAX_PAGE_SIZE,
  );
  const effectivePage = page ?? 1;
  return {
    page: effectivePage,
    pageSize: effectiveSize,
    query: { page: effectivePage, pageSize: effectiveSize },
  };
}
