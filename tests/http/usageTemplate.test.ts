import { describe, it, expect } from "vitest";
import { renderBarChart } from "../../src/http/admin-templates.js";

describe("renderBarChart", () => {
  it("emits an <svg> with one <rect> per value", () => {
    const html = renderBarChart([1, 2, 3, 0], { labelEvery: 1, axisLabels: ["a","b","c","d"] });
    expect(html).toContain("<svg");
    expect((html.match(/<rect /g) ?? []).length).toBe(4);
  });

  it("includes the count as a hover title on each bar", () => {
    const html = renderBarChart([7, 0, 5], { labelEvery: 1, axisLabels: ["x","y","z"] });
    expect(html).toContain("<title>7</title>");
    expect(html).toContain("<title>0</title>");
    expect(html).toContain("<title>5</title>");
  });

  it("renders all-zero input without dividing by zero", () => {
    const html = renderBarChart([0, 0, 0], { labelEvery: 1, axisLabels: ["a","b","c"] });
    expect(html).toContain("<svg");
    expect((html.match(/<rect /g) ?? []).length).toBe(3);
  });

  it("places X-axis labels every Nth bar via labelEvery", () => {
    const labels = Array.from({ length: 10 }, (_, i) => String(i));
    const html = renderBarChart(Array(10).fill(1), { labelEvery: 5, axisLabels: labels });
    // Only every 5th label should be rendered as <text>: labels 0 and 5.
    expect(html).toContain(">0<");
    expect(html).toContain(">5<");
    expect(html).not.toContain(">3<");
  });
});
