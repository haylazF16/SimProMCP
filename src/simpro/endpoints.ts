// Simpro REST API endpoint paths.
// All paths are RELATIVE to SIMPRO_BASE_URL.
//
// IMPORTANT: If your Simpro tenant uses a different API version or path shape,
// adjust the constants below — every tool consumes paths from this file so this
// is the SINGLE place to update.
//
// Reference: https://developer.simprogroup.com/apidoc/

export const API_VERSION = "v1.0";
const API_PREFIX = `/api/${API_VERSION}`;

/** Path scoped to a company, e.g. companyPath("0", "/customers/") */
export function companyPath(companyId: string, suffix: string): string {
  const cleanSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${API_PREFIX}/companies/${encodeURIComponent(companyId)}${cleanSuffix}`;
}

/** Top-level (non-company-scoped) path, e.g. info endpoint */
export function rootPath(suffix: string): string {
  const cleanSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${API_PREFIX}${cleanSuffix}`;
}

// Resource suffixes — joined with companyPath() at call sites.
export const ENDPOINTS = {
  customers: "/customers/",
  // Simpro requires the typed sub-path for individual record GET/PATCH:
  //   /customers/companies/{id}    for company customers
  //   /customers/individuals/{id}  for individual customers
  // The bare /customers/{id} returns 404 with "Invalid resource URI".
  // The search/list endpoint /customers/ returns BOTH types and each row
  // includes a `Type: "Company" | "Individual"` field plus an `_href`.
  customerCompanyById: (id: string | number) => `/customers/companies/${encodeURIComponent(String(id))}`,
  customerIndividualById: (id: string | number) => `/customers/individuals/${encodeURIComponent(String(id))}`,
  customersCompanies: "/customers/companies/",
  customersIndividuals: "/customers/individuals/",

  sites: "/sites/",
  siteById: (id: string | number) => `/sites/${encodeURIComponent(String(id))}`,

  jobs: "/jobs/",
  jobById: (id: string | number) => `/jobs/${encodeURIComponent(String(id))}`,
  jobNotes: (jobId: string | number) => `/jobs/${encodeURIComponent(String(jobId))}/notes/`,

  quotes: "/quotes/",
  quoteById: (id: string | number) => `/quotes/${encodeURIComponent(String(id))}`,

  invoices: "/invoices/",
  invoiceById: (id: string | number) => `/invoices/${encodeURIComponent(String(id))}`,

  tasks: "/tasks/",
  taskById: (id: string | number) => `/tasks/${encodeURIComponent(String(id))}`,

  // Suppliers — Simpro's API calls them "vendors" but UI/users say "suppliers".
  // Filter column is `Name` (substring match with %wildcards%).
  suppliers: "/vendors/",
  supplierById: (id: string | number) => `/vendors/${encodeURIComponent(String(id))}`,
  /** Purchase orders raised to a supplier. */
  vendorOrders: "/vendorOrders/",
  vendorOrderById: (id: string | number) => `/vendorOrders/${encodeURIComponent(String(id))}`,
  /**
   * Supplier invoices / bills received against vendor orders.
   * Detail GETs are NESTED under the order, e.g.
   *   /vendorOrders/{orderId}/receipts/{receiptId}
   * The bare /vendorReceipts/{id} returns 404. Use the list endpoint with
   * ?ID=<id> to discover the parent vendorOrder ID first.
   */
  vendorReceipts: "/vendorReceipts/",
  vendorReceiptByOrderAndId: (orderId: string | number, receiptId: string | number) =>
    `/vendorOrders/${encodeURIComponent(String(orderId))}/receipts/${encodeURIComponent(String(receiptId))}`,

  /** PO line items live under the order (NOT under /vendorOrders/{id}/items/). */
  vendorOrderItems: (orderId: string | number) =>
    `/vendorOrders/${encodeURIComponent(String(orderId))}/catalogs/`,
  vendorOrderItemById: (orderId: string | number, catalogId: string | number) =>
    `/vendorOrders/${encodeURIComponent(String(orderId))}/catalogs/${encodeURIComponent(String(catalogId))}`,
  /** Supplier-invoice (vendor receipt) line items live under the parent order. */
  vendorReceiptItems: (orderId: string | number, receiptId: string | number) =>
    `/vendorOrders/${encodeURIComponent(String(orderId))}/receipts/${encodeURIComponent(String(receiptId))}/catalogs/`,

  // Parts / inventory catalog
  catalogs: "/catalogs/",
  catalogById: (id: string | number) => `/catalogs/${encodeURIComponent(String(id))}`,
  // Warehouses / vehicles / storage locations
  storageDevices: "/storageDevices/",
  storageDeviceById: (id: string | number) => `/storageDevices/${encodeURIComponent(String(id))}`,
  // Stocktake history
  stockTakes: "/stockTakes/",
  stockTakeById: (id: string | number) => `/stockTakes/${encodeURIComponent(String(id))}`,

  // CRM
  contacts: "/contacts/",
  contactById: (id: string | number) => `/contacts/${encodeURIComponent(String(id))}`,
  leads: "/leads/",
  leadById: (id: string | number) => `/leads/${encodeURIComponent(String(id))}`,

  // Scheduling
  schedules: "/schedules/",
  timesheets: "/timesheets/",

  // Financials
  customerPayments: "/customerPayments/",
  creditNotes: "/creditNotes/",
  creditNoteById: (id: string | number) => `/creditNotes/${encodeURIComponent(String(id))}`,
  recurringInvoices: "/recurringInvoices/",
  recurringJobs: "/recurringJobs/",
  recurringJobById: (id: string | number) => `/recurringJobs/${encodeURIComponent(String(id))}`,

  // Discovery / lookup endpoints
  // VERIFIED working against goldmanplumbingservices.simprosuite.com (v26.2.3, AU):
  staff: "/staff/",
  costCentres: "/setup/accounts/costCenters/",
  // NOTE: this tenant does NOT expose dedicated /setup/.../statuses or /types
  // endpoints. The corresponding discovery tools sample existing jobs/quotes
  // instead. If your tenant exposes them, change these paths and update the
  // `simpro_list_*` tools in src/tools/jobs.ts and quotes.ts to use client.get
  // directly again.
  jobStatuses: "(sampled-from-jobs)",
  quoteStatuses: "(sampled-from-quotes)",
  jobTypes: "(sampled-from-jobs)",
  quoteTypes: "(sampled-from-quotes)",

  // Account / company info
  info: "/info/",
} as const;
