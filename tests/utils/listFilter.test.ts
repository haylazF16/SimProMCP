import { describe, it, expect } from "vitest";
import { applyClientFilters } from "../../src/utils/listFilter.js";

const rows = [
  { ID: 1, Customer: { ID: 10, Name: "Goldman" }, Site: { ID: 100 }, Status: { Name: "Open" }, DateIssued: "2026-01-15" },
  { ID: 2, Customer: { ID: 20, Name: "Acme" }, Site: { ID: 200 }, Status: "Closed", DateIssued: "2026-02-20T08:30:00+10:00" },
  { ID: 3, Customer: { ID: 10, Name: "Goldman" }, Site: { ID: 300 }, Status: { Name: "open" }, DateIssued: "2026-03-10" },
  { ID: 4, CustomerID: 10, SiteID: 400, Status: { Stage: "Pending" } }, // flat ids, no date
];

describe("applyClientFilters", () => {
  it("no filters → passthrough unchanged", () => {
    expect(applyClientFilters(rows, {}, { dateField: "DateIssued" })).toEqual(rows);
  });

  it("customerId (nested) numeric vs string coercion", () => {
    expect(applyClientFilters(rows, { customerId: 10 }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([1, 3, 4]);
    expect(applyClientFilters(rows, { customerId: "10" }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([1, 3, 4]);
  });

  it("customerId matches flat CustomerID shape", () => {
    expect(applyClientFilters(rows, { customerId: 20 }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([2]);
  });

  it("siteId nested and flat", () => {
    expect(applyClientFilters(rows, { siteId: 300 }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([3]);
    expect(applyClientFilters(rows, { siteId: "400" }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([4]);
  });

  it("status case-insensitive, object .Name and string", () => {
    expect(applyClientFilters(rows, { status: "OPEN" }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([1, 3]);
    expect(applyClientFilters(rows, { status: "closed" }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([2]);
  });

  it("status object .Stage fallback", () => {
    expect(applyClientFilters(rows, { status: "pending" }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([4]);
  });

  it("date range inclusive on both edges", () => {
    const r = applyClientFilters(rows, { dateFrom: "2026-01-15", dateTo: "2026-02-20" }, { dateField: "DateIssued" });
    expect(r.map((x) => x.ID)).toEqual([1, 2]); // both edges included; datetime row trimmed to yyyy-mm-dd
  });

  it("dateFrom only / dateTo only", () => {
    expect(applyClientFilters(rows, { dateFrom: "2026-03-01" }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([3]);
    expect(applyClientFilters(rows, { dateTo: "2026-01-31" }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([1]);
  });

  it("row missing date excluded when a date filter is set", () => {
    expect(applyClientFilters(rows, { dateFrom: "2020-01-01" }, { dateField: "DateIssued" }).map((r) => r.ID)).toEqual([1, 2, 3]);
  });

  it("combined filters AND together", () => {
    const r = applyClientFilters(
      rows,
      { customerId: 10, status: "open", dateFrom: "2026-02-01" },
      { dateField: "DateIssued" },
    );
    expect(r.map((x) => x.ID)).toEqual([3]);
  });

  it("empty status string is a no-op", () => {
    expect(applyClientFilters(rows, { status: "" }, { dateField: "DateIssued" })).toEqual(rows);
  });
});
