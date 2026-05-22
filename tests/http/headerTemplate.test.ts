import { describe, it, expect } from "vitest";
import { renderHeader } from "../../src/http/admin-templates.js";

describe("renderHeader", () => {
  it("contains a clickable brand link to /admin with the logo image", () => {
    const html = renderHeader("Usage", "Tayfun");
    expect(html).toMatch(/<a[^>]+href="\/admin"[^>]+class="brand"/);
    expect(html).toContain('src="/admin/static/logo.svg"');
  });

  it("renders the page title and admin name (escaped)", () => {
    const html = renderHeader("Audit log", "<Sarah>");
    expect(html).toContain("Audit log");
    expect(html).toContain("&lt;Sarah&gt;");
  });

  it("includes the standard nav links + logout button", () => {
    const html = renderHeader("Usage", "Tayfun");
    expect(html).toContain('href="/admin"');
    expect(html).toContain('href="/admin/audit"');
    expect(html).toContain('href="/admin/usage"');
    expect(html).toContain('href="/admin/users/new"');
    expect(html).toContain('action="/admin/logout"');
  });
});
