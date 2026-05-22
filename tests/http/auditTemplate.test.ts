// tests/http/auditTemplate.test.ts
import { describe, it, expect } from "vitest";
import { renderAuditView } from "../../src/http/admin-templates.js";

const baseLines = (extra: Record<string, unknown> = {}) => [JSON.stringify({
  ts: new Date().toISOString(),
  user: "Tayfun",
  company: "plumbing",
  tool: "simpro_get_purchase_order",
  ok: true,
  durationMs: 50,
  ...extra,
})];

describe("renderAuditView — inline detail", () => {
  it("shows the details suffix inline with the action when present", () => {
    const html = renderAuditView("Admin", baseLines({ details: "#1234" }));
    // The action humanizes to "Viewed purchase order"; details appends inline.
    expect(html).toContain("Viewed purchase order");
    expect(html).toContain("#1234");
  });

  it("renders without crash and without a detail span when details is missing", () => {
    const html = renderAuditView("Admin", baseLines());
    expect(html).toContain("Viewed purchase order");
    // Bare action, no extra span — sanity check the muted detail class isn't rendered empty.
    expect(html).not.toMatch(/<span class="detail">\s*<\/span>/);
  });
});
