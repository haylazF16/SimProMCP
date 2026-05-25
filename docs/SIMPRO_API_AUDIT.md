# Simpro API gap audit

> Produced 2026-05-25 by diffing the endpoint inventory in
> `docs/SIMPRO_API_INVENTORY.json` against the MCP tools defined in
> `src/tools/*.ts`. The endpoint inventory itself was derived from our
> own `src/simpro/endpoints.ts` (the public Simpro apidoc was gated, see
> the inventory file's `source` field for details), supplemented by
> public references found via web search. Re-run by editing the
> inventory JSON and regenerating this markdown. The H/M/L priorities
> are opinionated — feel free to adjust on review.

## Summary

- **Total endpoints documented:** 132
- **Covered by an MCP tool:** 67 (50.8%)
- **Missing:** 65
  - High priority (writes on workflows you use or want): **8**
  - Medium (cleanup, edge cases): **40**
  - Low (rare resources, long-tail): **17**

### Coverage by resource (sorted, lowest first)

| Resource | Endpoints | Covered | % | Top missing |
|---|---|---|---|---|
| Recurring Invoices | 5 | 1 | 20% | POST /recurringInvoices/ — M |
| Schedules | 5 | 1 | 20% | POST /schedules/ — M |
| Timesheets | 5 | 1 | 20% | POST /timesheets/ — M |
| Customer Payments | 4 | 1 | 25% | POST /customerPayments/ — H |
| Contacts | 5 | 2 | 40% | POST /contacts/ — H |
| Credit Notes | 5 | 2 | 40% | POST /creditNotes/ — M |
| Invoices | 5 | 2 | 40% | POST /invoices/ — H |
| Leads | 5 | 2 | 40% | POST /leads/ — M |
| Recurring Jobs | 5 | 2 | 40% | POST /recurringJobs/ — M |
| Storage Devices | 5 | 2 | 40% | POST /storageDevices/ — M |
| Stock Takes | 5 | 2 | 40% | POST /stockTakes/ — M |
| Tasks | 5 | 2 | 40% | GET /tasks/ — L |
| Jobs | 17 | 8 | 47% | PATCH /jobs/{id}/sections/{id} — H |
| Staff | 2 | 1 | 50% | GET /staff/{staffId} — L |
| Cost Centres (Setup) | 2 | 1 | 50% | GET /setup/accounts/costCenters/{id} — L |
| Purchase Orders (Vendor Orders) | 12 | 7 | 58% | PATCH /vendorOrders/{id} — H |
| Catalog (Parts) | 5 | 3 | 60% | PATCH /catalogs/{id} — M |
| Customers | 11 | 7 | 64% | DELETE /customers/companies/{id} — M |
| Supplier Invoices (Vendor Receipts) | 4 | 3 | 75% | GET /vendorOrders/{id}/receipts/{id}/catalogs/{id} — L |
| Sites | 5 | 4 | 80% | DELETE /sites/{id} — M |
| Quotes | 5 | 4 | 80% | DELETE /quotes/{id} — M |
| Vendors (Suppliers) | 5 | 4 | 80% | DELETE /vendors/{id} — M |
| Job Statuses (Sampled) | 1 | 1 | 100% | — |
| Quote Statuses (Sampled) | 1 | 1 | 100% | — |
| Job Types (Sampled) | 1 | 1 | 100% | — |
| Quote Types (Sampled) | 1 | 1 | 100% | — |
| Company Info | 1 | 1 | 100% | — |

### Priority rubric

- **H** = write op (POST/PATCH/PUT) AND it's in your 4 priority workflows (Jobs, POs, Quotes, Invoices, CustomerPayments, Customers, Sites, Contacts).
- **M** = DELETE on any resource, OR write op on a lower-priority resource (Leads, RecurringJobs, Schedules, etc.).
- **L** = everything else. Read-only ops we haven't bothered with yet.

### Caveat: inventory source

The inventory was built from our own live-verified `endpoints.ts` because Simpro's public apidoc requires login. All 132 endpoints are marked `inferred: true` in the JSON. This means the audit will:
- ✅ Surface gaps WITHIN endpoints we already know about (which is most of what matters for the 4 priority workflows)
- ❌ NOT surface endpoints in resources we've never touched (e.g. Contractor management, Plant equipment, Vehicle tracking, Asset management, etc.). If you ever want those, you'd need to enumerate them separately.

---

## Customer Payments

> Money received from customers against invoices.

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /customerPayments/ | simpro_search_customer_payments |

### Missing (3)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /customerPayments/ | Record a new customer payment | H | Closing the payment loop without touching the web UI |
| DELETE | /customerPayments/{paymentId} | Delete a customer payment record | M | Reversal / correction flow |
| GET | /customerPayments/{paymentId} | Get a specific customer payment by ID | L | Rarely needed once search works |

---

## Contacts

> Individual people (contacts) linked to customers or sites — name, email, phone, position.

### Covered (2)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /contacts/ | simpro_search_contacts |
| GET | /contacts/{contactId} | simpro_get_contact |

### Missing (3)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /contacts/ | Create a new contact | H | Creating a contact for a new site/customer without the web UI |
| PATCH | /contacts/{contactId} | Update a contact (partial update) | H | Updating phone/email from a form or email |
| DELETE | /contacts/{contactId} | Delete a contact | M | Cleanup of stale contacts |

---

## Invoices

> Customer-facing invoices generated from completed jobs or quotes.

### Covered (2)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /invoices/ | simpro_search_invoices |
| GET | /invoices/{invoiceId} | simpro_get_invoice |

### Missing (3)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /invoices/ | Create a new invoice | H | Raising an invoice directly (e.g. for a recurring service) |
| PATCH | /invoices/{invoiceId} | Update an invoice (partial update) | H | Updating due date, reference, or status |
| DELETE | /invoices/{invoiceId} | Delete an invoice | M | Voiding a mistakenly raised invoice |

---

## Jobs

> Service and project jobs — the primary work unit in Simpro. Sections and CostCenters are mandatory sub-resources.

### Covered (8)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /jobs/ | simpro_search_jobs, simpro_list_job_statuses, simpro_list_job_types |
| GET | /jobs/{jobId} | simpro_get_job |
| POST | /jobs/ | simpro_create_job |
| GET | /jobs/{jobId}/sections/ | simpro_list_job_sections |
| POST | /jobs/{jobId}/sections/ | simpro_add_job_section |
| POST | /jobs/{jobId}/sections/{sectionId}/costCenters/ | simpro_add_job_section, simpro_add_section_cost_centre |
| POST | /jobs/{jobId}/notes/ | simpro_add_job_note, simpro_attach_file_link_to_job |
| PATCH | /jobs/{jobId} | simpro_update_job |

### Missing (9)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| PATCH | /jobs/{jobId}/sections/{sectionId} | Update a job section | H | Renaming a section after creation |
| DELETE | /jobs/{jobId} | Delete a job | M | Removing a mistaken job (rare but needed) |
| DELETE | /jobs/{jobId}/sections/{sectionId} | Delete a job section | M | Removing wrong sections after creation |
| DELETE | /jobs/{jobId}/sections/{sectionId}/costCenters/{costCenterId} | Remove a cost-centre line item from a section | M | Cleanup after attaching wrong cost centre |
| GET | /jobs/{jobId}/notes/ | List notes on a job | L | Search already covers most note discovery needs |
| GET | /jobs/{jobId}/notes/{noteId} | Get a specific job note by ID | L | Rarely needed |
| GET | /jobs/{jobId}/sections/{sectionId} | Get a specific section by ID | L | simpro_list_job_sections covers most cases |
| GET | /jobs/{jobId}/sections/{sectionId}/costCenters/ | List cost-centre line items on a section | L | Covered indirectly via simpro_list_job_sections |
| GET | /jobs/{jobId}/sections/{sectionId}/costCenters/{costCenterId} | Get a specific cost-centre line item | L | Rarely needed individually |

---

## Purchase Orders (Vendor Orders)

> Purchase orders raised to suppliers, attached to job cost centres.

### Covered (7)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /vendorOrders/ | simpro_search_purchase_orders |
| GET | /vendorOrders/{orderId} | simpro_get_purchase_order |
| POST | /vendorOrders/ | simpro_create_purchase_order |
| GET | /vendorOrders/{orderId}/catalogs/ | simpro_list_purchase_order_items |
| POST | /vendorOrders/{orderId}/catalogs/ | simpro_add_purchase_order_item |
| GET | /vendorOrders/{orderId}/catalogs/{catalogId} | simpro_get_purchase_order_item |
| GET | /vendorOrders/{orderId}/receipts/{receiptId} | simpro_get_supplier_invoice |

### Missing (5)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| PATCH | /vendorOrders/{orderId} | Update a purchase order (partial update) | H | Updating reference, dates, notes on an existing PO |
| PATCH | /vendorOrders/{orderId}/catalogs/{catalogId} | Update a PO line item (e.g. change quantity or price) | H | Correcting quantity/price on an existing line |
| DELETE | /vendorOrders/{orderId} | Delete a purchase order | M | Cancelling a wrongly raised PO |
| DELETE | /vendorOrders/{orderId}/catalogs/{catalogId} | Remove a line item from a PO | M | Removing wrong items from a PO |
| GET | /vendorOrders/{orderId}/receipts/ | List receipts (supplier invoices) under a PO | L | simpro_search_supplier_invoices covers most cases |

---

## Quotes

> Customer quotations that can be converted to jobs once approved.

### Covered (4)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /quotes/ | simpro_search_quotes, simpro_list_quote_statuses, simpro_list_quote_types |
| GET | /quotes/{quoteId} | simpro_get_quote |
| POST | /quotes/ | simpro_create_quote |
| PATCH | /quotes/{quoteId} | simpro_update_quote |

### Missing (1)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| DELETE | /quotes/{quoteId} | Delete a quote | M | Removing stale or test quotes |

---

## Customers

> Company and individual customers that jobs, quotes, and invoices are raised against.

### Covered (7)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /customers/ | simpro_search_customers |
| GET | /customers/companies/{customerId} | simpro_get_customer |
| GET | /customers/individuals/{customerId} | simpro_get_customer |
| POST | /customers/companies/ | simpro_create_customer |
| POST | /customers/individuals/ | simpro_create_customer |
| PATCH | /customers/companies/{customerId} | simpro_update_customer |
| PATCH | /customers/individuals/{customerId} | simpro_update_customer |

### Missing (4)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| DELETE | /customers/companies/{customerId} | Delete a company customer | M | GDPR-style data cleanup or test data removal |
| DELETE | /customers/individuals/{customerId} | Delete an individual customer | M | GDPR-style data cleanup or test data removal |
| GET | /customers/companies/ | List company-type customers only | L | simpro_search_customers covers both types |
| GET | /customers/individuals/ | List individual-type customers only | L | simpro_search_customers covers both types |

---

## Vendor (Supplier) Invoices

> Supplier invoices / bills received against vendor orders.

### Covered (3)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /vendorReceipts/ | simpro_search_supplier_invoices, simpro_get_supplier_invoice |
| GET | /vendorOrders/{orderId}/receipts/{receiptId} | simpro_get_supplier_invoice |
| GET | /vendorOrders/{orderId}/receipts/{receiptId}/catalogs/ | simpro_list_supplier_invoice_items |

### Missing (1)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| GET | /vendorOrders/{orderId}/receipts/{receiptId}/catalogs/{catalogId} | Get a specific supplier invoice line item by ID | L | List endpoint covers most use cases |

---

## Sites

> Physical service locations / job sites associated with customers.

### Covered (4)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /sites/ | simpro_search_sites |
| GET | /sites/{siteId} | simpro_get_site |
| POST | /sites/ | simpro_create_site |
| PATCH | /sites/{siteId} | simpro_update_site |

### Missing (1)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| DELETE | /sites/{siteId} | Delete a site | M | Removing duplicate or decommissioned sites |

---

## Vendors (Suppliers)

> Suppliers (stored under /vendors/ in the Simpro API).

### Covered (4)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /vendors/ | simpro_search_suppliers |
| GET | /vendors/{vendorId} | simpro_get_supplier |
| POST | /vendors/ | simpro_create_supplier |
| PATCH | /vendors/{vendorId} | simpro_update_supplier |

### Missing (1)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| DELETE | /vendors/{vendorId} | Delete a supplier | M | Archiving/removing suppliers (rarely needed — Simpro has an Archived flag) |

---

## Catalog (Parts)

> The parts catalog used for purchase order line items.

### Covered (3)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /catalogs/ | simpro_search_catalog |
| GET | /catalogs/{catalogId} | simpro_get_catalog_item |
| POST | /catalogs/ | simpro_create_catalog_item |

### Missing (2)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| PATCH | /catalogs/{catalogId} | Update a catalog item (e.g. price, name, part number) | M | Keeping the catalog up to date when supplier prices change |
| DELETE | /catalogs/{catalogId} | Delete a catalog item | M | Removing duplicates or obsolete parts |

---

## Tasks

> Internal tasks linked to jobs, customers, or staff.

### Covered (2)

| Method | Endpoint | Tool |
|---|---|---|
| POST | /tasks/ | simpro_create_task |
| PATCH | /tasks/{taskId} | simpro_update_task |

### Missing (3)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| DELETE | /tasks/{taskId} | Delete a task | M | Removing cancelled or test tasks |
| GET | /tasks/ | Search/list tasks | L | No search tool exists for tasks — a notable gap |
| GET | /tasks/{taskId} | Get a specific task by ID | L | No get tool exists — needed to retrieve task details |

---

## Credit Notes

> Credit notes issued to customers.

### Covered (2)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /creditNotes/ | simpro_search_credit_notes |
| GET | /creditNotes/{creditNoteId} | simpro_get_credit_note |

### Missing (3)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /creditNotes/ | Create a new credit note | M | Issuing credits without the web UI |
| PATCH | /creditNotes/{creditNoteId} | Update a credit note | M | Correcting or approving a credit note |
| DELETE | /creditNotes/{creditNoteId} | Delete a credit note | M | Removing erroneous credit notes |

---

## Leads

> Sales leads (CRM pipeline). May be unused if the leads module is not active.

### Covered (2)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /leads/ | simpro_search_leads |
| GET | /leads/{leadId} | simpro_get_lead |

### Missing (3)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /leads/ | Create a new lead | M | Adding a lead from an inquiry without the web UI |
| PATCH | /leads/{leadId} | Update a lead (partial update) | M | Updating lead status or details |
| DELETE | /leads/{leadId} | Delete a lead | M | Removing stale leads |

---

## Recurring Invoices

> Recurring invoice templates for repeat billing.

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /recurringInvoices/ | simpro_search_recurring_invoices |

### Missing (4)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /recurringInvoices/ | Create a new recurring invoice template | M | Setting up repeat billing without the web UI |
| PATCH | /recurringInvoices/{recurringInvoiceId} | Update a recurring invoice template | M | Adjusting amounts or schedule |
| DELETE | /recurringInvoices/{recurringInvoiceId} | Delete a recurring invoice template | M | Removing cancelled contracts |
| GET | /recurringInvoices/{recurringInvoiceId} | Get a specific recurring invoice by ID | L | Search covers most lookups |

---

## Recurring Jobs

> Recurring job templates for preventive maintenance contracts.

### Covered (2)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /recurringJobs/ | simpro_search_recurring_jobs |
| GET | /recurringJobs/{recurringJobId} | simpro_get_recurring_job |

### Missing (3)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /recurringJobs/ | Create a new recurring job template | M | Setting up PM contracts without the web UI |
| PATCH | /recurringJobs/{recurringJobId} | Update a recurring job template | M | Adjusting frequency, description, or assigned staff |
| DELETE | /recurringJobs/{recurringJobId} | Delete a recurring job template | M | Removing cancelled PM contracts |

---

## Schedules

> Staff work schedules and assigned blocks.

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /schedules/ | simpro_search_schedules |

### Missing (4)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /schedules/ | Create a new schedule block | M | Dispatching staff to a job without the web UI |
| PATCH | /schedules/{scheduleId} | Update a schedule (reschedule or reassign) | M | Moving an appointment to another time/staff |
| DELETE | /schedules/{scheduleId} | Delete a schedule block | M | Removing cancelled appointments |
| GET | /schedules/{scheduleId} | Get a specific schedule block by ID | L | Search covers most lookups |

---

## Timesheets

> Staff labour hours (recorded time, not scheduled time).

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /timesheets/ | simpro_search_timesheets |

### Missing (4)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /timesheets/ | Create a new timesheet entry | M | Adding a time entry without the web UI or mobile app |
| PATCH | /timesheets/{uid} | Update a timesheet entry | M | Correcting hours or rate |
| DELETE | /timesheets/{uid} | Delete a timesheet entry | M | Removing duplicate or erroneous entries |
| GET | /timesheets/{uid} | Get a specific timesheet entry by UID | L | Search covers most lookups |

---

## Storage Devices

> Warehouses, vans, vehicles — physical inventory locations.

### Covered (2)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /storageDevices/ | simpro_search_storage_devices |
| GET | /storageDevices/{storageDeviceId} | simpro_get_storage_device |

### Missing (3)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /storageDevices/ | Create a new storage device | M | Adding a new van or warehouse |
| PATCH | /storageDevices/{storageDeviceId} | Update a storage device | M | Renaming or updating a storage location |
| DELETE | /storageDevices/{storageDeviceId} | Delete a storage device | M | Removing a decommissioned vehicle or location |

---

## Stock Takes

> Stocktake history — counts and value adjustments per storage device.

### Covered (2)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /stockTakes/ | simpro_search_stock_takes |
| GET | /stockTakes/{stockTakeId} | simpro_get_stock_take |

### Missing (3)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| POST | /stockTakes/ | Create a new stocktake | M | Initiating a stock count without the web UI |
| PATCH | /stockTakes/{stockTakeId} | Update a stocktake (approve it, etc.) | M | Approving or adjusting a completed stocktake |
| DELETE | /stockTakes/{stockTakeId} | Delete a stocktake | M | Removing an erroneous or test stocktake |

---

## Staff

> Staff members (employees) in Simpro.

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /staff/ | simpro_list_staff |

### Missing (1)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| GET | /staff/{staffId} | Get a specific staff member by ID | L | Rarely needed individually |

---

## Cost Centres (Setup)

> Cost centre types used as line-item categories on sections.

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /setup/accounts/costCenters/ | simpro_list_cost_centres |

### Missing (1)

| Method | Endpoint | Description | Priority | Notes |
|---|---|---|---|---|
| GET | /setup/accounts/costCenters/{costCenterId} | Get a specific cost centre by ID | L | List endpoint is sufficient for most lookups |

---

## Job Statuses (Sampled)

> Job status values, derived by sampling recent jobs (no dedicated endpoint on this tenant).

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /jobs/ (sampled) | simpro_list_job_statuses |

### Missing (0)

(none)

---

## Quote Statuses (Sampled)

> Quote status values, derived by sampling recent quotes.

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /quotes/ (sampled) | simpro_list_quote_statuses |

### Missing (0)

(none)

---

## Job Types (Sampled)

> Job type values (Service/Project), derived by sampling recent jobs.

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /jobs/ (sampled) | simpro_list_job_types |

### Missing (0)

(none)

---

## Quote Types (Sampled)

> Quote type values, derived by sampling recent quotes.

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /quotes/ (sampled) | simpro_list_quote_types |

### Missing (0)

(none)

---

## Company Info

> Connection test / account info endpoint.

### Covered (1)

| Method | Endpoint | Tool |
|---|---|---|
| GET | /info/ | simpro_get_company_info |

### Missing (0)

(none)

---

## What to do with this audit

1. **Skim the Summary.** Anything surprise you? The biggest shock is Tasks having no search/get tool — you can create and update tasks but can't list or retrieve them without the web UI.
2. **Edit priorities** if my rubric disagrees with what you actually need. In particular:
   - `POST /customerPayments/` is H — this is the "payment received, close the invoice" flow that likely matters.
   - `PATCH /vendorOrders/{id}` and `PATCH /vendorOrders/{id}/catalogs/{id}` are H — correcting a PO after creation.
   - `POST /invoices/` and `PATCH /invoices/{id}` are H — direct invoice creation without converting a job.
3. **Once happy**, ask Claude to brainstorm the next gap-fill batch. Likely shape:
   - **Contacts + Invoices + Customer Payments** — 6 tools, closes the biggest workflow gaps (contacts CRUD, invoice write, payment record).
   - **Jobs + POs cleanup** — PATCH section, DELETE job/section/cost-centre, PATCH PO + PO line item. ~6 tools.
   - **Tasks list/get** — 2 missing read tools for an entity we can already write.
   - **Catalog PATCH** — keeping parts pricing up to date as supplier costs change.
