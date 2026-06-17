import { describe, it, expect } from "vitest";
import {
  pickSource,
  deriveFilename,
  guessMime,
  stagingPathForRef,
} from "../../src/utils/files.js";

describe("files.ts pure helpers", () => {
  it("pickSource returns the single populated source", () => {
    expect(pickSource({ sourceUrl: "https://e.com/a.pdf" })).toBe("sourceUrl");
    expect(pickSource({ filePath: "/tmp/a.pdf" })).toBe("filePath");
    expect(pickSource({ stagingRef: "abc123" })).toBe("stagingRef");
  });

  it("pickSource throws when zero or more-than-one source is given", () => {
    expect(() => pickSource({})).toThrow(/exactly one/i);
    expect(() => pickSource({ filePath: "/a", stagingRef: "b1c2d3" })).toThrow(/exactly one/i);
  });

  it("deriveFilename prefers explicit filename, then URL/path basename", () => {
    expect(deriveFilename({ sourceUrl: "https://e.com/x/site-photo.jpg?t=1" })).toBe("site-photo.jpg");
    expect(deriveFilename({ filePath: "/var/data/docket.pdf" })).toBe("docket.pdf");
    expect(deriveFilename({ sourceUrl: "https://e.com/a.bin", filename: "real.pdf" })).toBe("real.pdf");
  });

  it("guessMime maps known extensions and defaults to octet-stream", () => {
    expect(guessMime("a.png")).toBe("image/png");
    expect(guessMime("a.PDF")).toBe("application/pdf");
    expect(guessMime("a.unknownext")).toBe("application/octet-stream");
  });

  it("stagingPathForRef rejects path-traversal / bad tokens", () => {
    expect(() => stagingPathForRef("/staging", "../etc")).toThrow(/invalid staging ref/i);
    expect(() => stagingPathForRef("/staging", "a/b")).toThrow(/invalid staging ref/i);
    expect(stagingPathForRef("/staging", "abc123XYZ")).toContain("abc123XYZ");
  });
});
