// tests/_sanity.test.ts
import { describe, it, expect } from "vitest";

describe("vitest sanity check", () => {
  it("can run a TypeScript test", () => {
    const x: number = 1 + 1;
    expect(x).toBe(2);
  });
});
