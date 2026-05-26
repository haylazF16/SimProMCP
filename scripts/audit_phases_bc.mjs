import { readFileSync, writeFileSync } from 'fs';

function normalize(p) {
  return p
    .toLowerCase()
    .replace(/[{<:][a-z_]+[}>]?/gi, '{id}')
    .replace(/\/+$/, '')
    .replace(/\/+/g, '/');
}

const toolEndpoints = [
  { tool: "simpro_search_customers", method: "GET", path: "/customers/" },
  { tool: "simpro_get_customer", method: "GET", path: "/customers/companies/{id}" },
  { tool: "simpro_get_customer", method: "GET", path: "/customers/individuals/{id}" },
  { tool: "simpro_create_customer", method: "POST", path: "/customers/companies/" },
  { tool: "simpro_create_customer", method: "POST", path: "/customers/individuals/" },
  { tool: "simpro_update_customer", method: "PATCH", path: "/customers/companies/{id}" },
  { tool: "simpro_update_customer", method: "PATCH", path: "/customers/individuals/{id}" },
  { tool: "simpro_search_sites", method: "GET", path: "/sites/" },
  { tool: "simpro_get_site", method: "GET", path: "/sites/{id}" },
  { tool: "simpro_create_site", method: "POST", path: "/sites/" },
  { tool: "simpro_update_site", method: "PATCH", path: "/sites/{id}" },
  { tool: "simpro_search_contacts", method: "GET", path: "/contacts/" },
  { tool: "simpro_get_contact", method: "GET", path: "/contacts/{id}" },
  { tool: "simpro_search_leads", method: "GET", path: "/leads/" },
  { tool: "simpro_get_lead", method: "GET", path: "/leads/{id}" },
  { tool: "simpro_search_jobs", method: "GET", path: "/jobs/" },
  { tool: "simpro_get_job", method: "GET", path: "/jobs/{id}" },
  { tool: "simpro_create_job", method: "POST", path: "/jobs/" },
  { tool: "simpro_list_job_sections", method: "GET", path: "/jobs/{id}/sections/" },
  { tool: "simpro_add_job_section", method: "POST", path: "/jobs/{id}/sections/" },
  { tool: "simpro_add_job_section", method: "POST", path: "/jobs/{id}/sections/{id}/costcenters/" },
  { tool: "simpro_add_section_cost_centre", method: "POST", path: "/jobs/{id}/sections/{id}/costcenters/" },
  { tool: "simpro_update_job", method: "PATCH", path: "/jobs/{id}" },
  { tool: "simpro_add_job_note", method: "POST", path: "/jobs/{id}/notes/" },
  { tool: "simpro_attach_file_link_to_job", method: "POST", path: "/jobs/{id}/notes/" },
  { tool: "simpro_get_company_info", method: "GET", path: "/info/" },
  { tool: "simpro_search_quotes", method: "GET", path: "/quotes/" },
  { tool: "simpro_get_quote", method: "GET", path: "/quotes/{id}" },
  { tool: "simpro_create_quote", method: "POST", path: "/quotes/" },
  { tool: "simpro_update_quote", method: "PATCH", path: "/quotes/{id}" },
  { tool: "simpro_search_invoices", method: "GET", path: "/invoices/" },
  { tool: "simpro_get_invoice", method: "GET", path: "/invoices/{id}" },
  { tool: "simpro_create_task", method: "POST", path: "/tasks/" },
  { tool: "simpro_update_task", method: "PATCH", path: "/tasks/{id}" },
  { tool: "simpro_list_staff", method: "GET", path: "/staff/" },
  { tool: "simpro_list_cost_centres", method: "GET", path: "/setup/accounts/costcenters/" },
  { tool: "simpro_search_suppliers", method: "GET", path: "/vendors/" },
  { tool: "simpro_get_supplier", method: "GET", path: "/vendors/{id}" },
  { tool: "simpro_create_supplier", method: "POST", path: "/vendors/" },
  { tool: "simpro_update_supplier", method: "PATCH", path: "/vendors/{id}" },
  { tool: "simpro_search_purchase_orders", method: "GET", path: "/vendororders/" },
  { tool: "simpro_get_purchase_order", method: "GET", path: "/vendororders/{id}" },
  { tool: "simpro_create_purchase_order", method: "POST", path: "/vendororders/" },
  { tool: "simpro_add_purchase_order_item", method: "POST", path: "/vendororders/{id}/catalogs/" },
  { tool: "simpro_list_purchase_order_items", method: "GET", path: "/vendororders/{id}/catalogs/" },
  { tool: "simpro_get_purchase_order_item", method: "GET", path: "/vendororders/{id}/catalogs/{id}" },
  { tool: "simpro_search_supplier_invoices", method: "GET", path: "/vendorreceipts/" },
  { tool: "simpro_get_supplier_invoice", method: "GET", path: "/vendorreceipts/" },
  { tool: "simpro_get_supplier_invoice", method: "GET", path: "/vendororders/{id}/receipts/{id}" },
  { tool: "simpro_list_supplier_invoice_items", method: "GET", path: "/vendororders/{id}/receipts/{id}/catalogs/" },
  { tool: "simpro_search_catalog", method: "GET", path: "/catalogs/" },
  { tool: "simpro_get_catalog_item", method: "GET", path: "/catalogs/{id}" },
  { tool: "simpro_create_catalog_item", method: "POST", path: "/catalogs/" },
  { tool: "simpro_search_storage_devices", method: "GET", path: "/storagedevices/" },
  { tool: "simpro_get_storage_device", method: "GET", path: "/storagedevices/{id}" },
  { tool: "simpro_search_stock_takes", method: "GET", path: "/stocktakes/" },
  { tool: "simpro_get_stock_take", method: "GET", path: "/stocktakes/{id}" },
  { tool: "simpro_search_customer_payments", method: "GET", path: "/customerpayments/" },
  { tool: "simpro_search_credit_notes", method: "GET", path: "/creditnotes/" },
  { tool: "simpro_get_credit_note", method: "GET", path: "/creditnotes/{id}" },
  { tool: "simpro_search_recurring_invoices", method: "GET", path: "/recurringinvoices/" },
  { tool: "simpro_search_schedules", method: "GET", path: "/schedules/" },
  { tool: "simpro_search_timesheets", method: "GET", path: "/timesheets/" },
  { tool: "simpro_search_recurring_jobs", method: "GET", path: "/recurringjobs/" },
  { tool: "simpro_get_recurring_job", method: "GET", path: "/recurringjobs/{id}" },
];

const toolLookup = new Map();
for (const t of toolEndpoints) {
  const normPath = normalize(t.path);
  const key = t.method + ":" + normPath;
  if (!toolLookup.has(key)) toolLookup.set(key, new Set());
  toolLookup.get(key).add(t.tool);
}

// Priority workflows
const priorityResources = new Set([
  'jobs', 'vendororders', 'sections', 'costcenters', 'quotes', 'invoices',
  'customerpayments', 'customers', 'sites', 'contacts'
]);

const inventoryPath = 'docs/SIMPRO_API_INVENTORY.json';
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));

let totalEndpoints = 0;
let coveredEndpoints = 0;
let H = 0, M = 0, L = 0;

function getFirstSegment(path) {
  const norm = normalize(path).replace(/^\//, '');
  return norm.split('/')[0];
}

for (const resource of inventory.resources) {
  for (const endpoint of resource.endpoints) {
    totalEndpoints++;
    const normPath = normalize(endpoint.path);
    const key = endpoint.method + ":" + normPath;
    const matchedTools = toolLookup.get(key);
    endpoint.coveredBy = matchedTools ? [...matchedTools].sort() : [];
    if (endpoint.coveredBy.length > 0) {
      coveredEndpoints++;
      delete endpoint.priority;
    } else {
      const isWrite = ["POST","PATCH","PUT"].includes(endpoint.method);
      const isDelete = endpoint.method === "DELETE";
      const seg = getFirstSegment(endpoint.path);
      const inPriority = priorityResources.has(seg);
      let priority;
      if (isDelete) {
        priority = "M";
      } else if (isWrite && inPriority) {
        priority = "H";
      } else if (isWrite) {
        priority = "M";
      } else {
        priority = "L";
      }
      endpoint.priority = priority;
      if (priority === "H") H++;
      else if (priority === "M") M++;
      else L++;
    }
  }
}

console.log("Total:", totalEndpoints);
console.log("Covered:", coveredEndpoints);
console.log("Missing:", totalEndpoints - coveredEndpoints);
console.log("Coverage:", (coveredEndpoints/totalEndpoints*100).toFixed(1) + "%");
console.log("H:", H, "M:", M, "L:", L);

// Show per-resource coverage
console.log("\nPer-resource coverage:");
for (const resource of inventory.resources) {
  const total = resource.endpoints.length;
  const covered = resource.endpoints.filter(e => e.coveredBy.length > 0).length;
  const pct = (covered/total*100).toFixed(0);
  console.log(`  ${resource.name}: ${covered}/${total} (${pct}%)`);
}

// Spot-check uncovered
let shown = 0;
console.log("\nSample uncovered:");
for (const resource of inventory.resources) {
  for (const endpoint of resource.endpoints) {
    if (endpoint.coveredBy.length === 0 && shown < 10) {
      console.log(" ", endpoint.method, endpoint.path, "->", normalize(endpoint.path), "[" + endpoint.priority + "]");
      shown++;
    }
  }
}

writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2), 'utf8');
console.log("\nSaved inventory with coveredBy + priority fields.");
