// Client-side filtering for Simpro v1.0 list endpoints.
//
// WHY THIS EXISTS: Simpro's list GET endpoints only filter by exact valid
// column names and SILENTLY IGNORE unknown query params. Params like
// CustomerID / SiteID / Status / DateIssuedFrom / DateIssuedTo are NOT valid
// list filters, so passing them did nothing — "find jobs for customer X"
// returned the unfiltered first page. We instead fetch a larger page and
// filter the rows here, against the real (Task-C-requested) nested shapes:
//   Customer/Site: { ID, Name }   Status: { Name } | string   date: DateIssued

export interface ClientFilters {
  customerId?: number | string;
  siteId?: number | string;
  status?: string;
  dateFrom?: string; // ISO yyyy-mm-dd
  dateTo?: string; // ISO yyyy-mm-dd
}

/** Resolve a row's customer/site id from either nested ref or flat field. */
function refId(nested: unknown, flat: unknown): string | undefined {
  if (nested && typeof nested === "object") {
    const id = (nested as { ID?: unknown }).ID;
    if (id !== undefined && id !== null) return String(id);
  }
  if (flat !== undefined && flat !== null) return String(flat);
  return undefined;
}

/** Resolve a row's status label from a string or a { Name | Stage } object. */
function statusLabel(status: unknown): string | undefined {
  if (typeof status === "string") return status;
  if (status && typeof status === "object") {
    const s = status as { Name?: unknown; Stage?: unknown };
    if (typeof s.Name === "string") return s.Name;
    if (typeof s.Stage === "string") return s.Stage;
  }
  return undefined;
}

/** First 10 chars (yyyy-mm-dd) of an ISO date/datetime string, or undefined. */
function dateKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : undefined;
}

export function applyClientFilters<T extends Record<string, any>>(
  rows: T[],
  f: ClientFilters,
  opts: { dateField: string },
): T[] {
  const wantCustomer = f.customerId !== undefined && f.customerId !== null;
  const wantSite = f.siteId !== undefined && f.siteId !== null;
  const wantStatus = f.status !== undefined && f.status !== "";
  const wantDate = !!f.dateFrom || !!f.dateTo;

  if (!wantCustomer && !wantSite && !wantStatus && !wantDate) return rows;

  const wantCustomerId = wantCustomer ? String(f.customerId) : undefined;
  const wantSiteId = wantSite ? String(f.siteId) : undefined;
  const wantStatusLc = wantStatus ? f.status!.toLowerCase() : undefined;

  return rows.filter((row) => {
    if (wantCustomerId !== undefined) {
      const id = refId(row.Customer, row.CustomerID);
      if (id !== wantCustomerId) return false;
    }
    if (wantSiteId !== undefined) {
      const id = refId(row.Site, row.SiteID);
      if (id !== wantSiteId) return false;
    }
    if (wantStatusLc !== undefined) {
      const label = statusLabel(row.Status);
      if (label === undefined || label.toLowerCase() !== wantStatusLc) return false;
    }
    if (wantDate) {
      const key = dateKey(row[opts.dateField]);
      if (key === undefined) return false; // missing/unparseable → exclude
      if (f.dateFrom && key < f.dateFrom) return false;
      if (f.dateTo && key > f.dateTo) return false;
    }
    return true;
  });
}
