import { describe, it, expect } from "vitest";
import { stripHtml } from "../../src/utils/sanitise.js";

describe("stripHtml", () => {
  it("removes tags", () => {
    expect(stripHtml("<p>Hi <b>there</b></p>")).toBe("Hi there");
  });

  it("decodes common entities", () => {
    expect(stripHtml("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
  });

  it("collapses whitespace", () => {
    expect(stripHtml("x\n\n   y")).toBe("x y");
  });

  it("passes plain text through unchanged", () => {
    expect(stripHtml("plain text")).toBe("plain text");
  });

  it("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });

  it("returns empty string for null/undefined", () => {
    expect(stripHtml(undefined)).toBe("");
    expect(stripHtml(null)).toBe("");
  });
});
