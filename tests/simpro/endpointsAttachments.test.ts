import { describe, it, expect } from "vitest";
import {
  ATTACHMENT_ENTITY_TYPES,
  ATTACHMENT_ENTITY_PATHS,
  attachmentFiles,
  attachmentFileById,
} from "../../src/simpro/endpoints.js";

describe("attachment endpoints", () => {
  it("maps each non-invoice entity to its parent suffix", () => {
    expect(ATTACHMENT_ENTITY_PATHS.job(132277)).toBe("/jobs/132277");
    expect(ATTACHMENT_ENTITY_PATHS.quote(3)).toBe("/quotes/3");
    expect(ATTACHMENT_ENTITY_PATHS.site(4)).toBe("/sites/4");
    expect(ATTACHMENT_ENTITY_PATHS.supplier(5)).toBe("/vendors/5");
    expect(ATTACHMENT_ENTITY_PATHS.employee(6)).toBe("/employees/6");
    expect(ATTACHMENT_ENTITY_PATHS.recurringJob(8)).toBe("/recurringJobs/8");
    expect(ATTACHMENT_ENTITY_PATHS.purchaseOrder(9)).toBe("/vendorOrders/9");
    // Customer uses the FLAT path for attachments (not companies/individuals).
    expect(ATTACHMENT_ENTITY_PATHS.customer(7)).toBe("/customers/7");
  });

  it("covers every declared non-invoice entity type with a path builder", () => {
    for (const t of ATTACHMENT_ENTITY_TYPES) {
      if (t === "invoice") continue;
      expect(typeof ATTACHMENT_ENTITY_PATHS[t], `missing path builder for ${t}`).toBe("function");
    }
  });

  it("includes invoice in the type list but NOT in the path map", () => {
    expect(ATTACHMENT_ENTITY_TYPES).toContain("invoice");
    expect(ATTACHMENT_ENTITY_PATHS).not.toHaveProperty("invoice");
  });

  it("builds files and file-by-id suffixes", () => {
    const parent = ATTACHMENT_ENTITY_PATHS.job(1);
    expect(attachmentFiles(parent)).toBe("/jobs/1/attachments/files/");
    expect(attachmentFileById(parent, 42)).toBe("/jobs/1/attachments/files/42");
  });
});
