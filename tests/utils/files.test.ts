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

import { afterEach, beforeEach } from "vitest";
import * as os from "node:os";
import * as nodePath from "node:path";
import { promises as fsp } from "node:fs";
import { resolveFileToBase64 } from "../../src/utils/files.js";

describe("resolveFileToBase64", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "simpro-files-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("reads a local filePath into base64 with a guessed mime", async () => {
    const p = nodePath.join(dir, "note.txt");
    await fsp.writeFile(p, "hello");
    const r = await resolveFileToBase64({ filePath: p }, { maxBytes: 1000, stagingDir: dir });
    expect(Buffer.from(r.base64, "base64").toString()).toBe("hello");
    expect(r.filename).toBe("note.txt");
    expect(r.mimeType).toBe("text/plain");
    expect(r.sizeBytes).toBe(5);
  });

  it("rejects a file over the size guard", async () => {
    const p = nodePath.join(dir, "big.bin");
    await fsp.writeFile(p, Buffer.alloc(2048));
    await expect(
      resolveFileToBase64({ filePath: p }, { maxBytes: 1024, stagingDir: dir }),
    ).rejects.toThrow(/over the/i);
  });

  it("reads a staged file by ref from <stagingDir>/<ref>/<filename>", async () => {
    const refDir = nodePath.join(dir, "ref123ABC");
    await fsp.mkdir(refDir, { recursive: true });
    await fsp.writeFile(nodePath.join(refDir, "docket.pdf"), "PDFBYTES");
    const r = await resolveFileToBase64({ stagingRef: "ref123ABC" }, { maxBytes: 1000, stagingDir: dir });
    expect(r.filename).toBe("docket.pdf");
    expect(r.mimeType).toBe("application/pdf");
    expect(Buffer.from(r.base64, "base64").toString()).toBe("PDFBYTES");
  });

  it("errors clearly when a staging ref is missing", async () => {
    await expect(
      resolveFileToBase64({ stagingRef: "missing99" }, { maxBytes: 1000, stagingDir: dir }),
    ).rejects.toThrow(/not found or expired/i);
  });

  it("detects an HTML share page on sourceUrl and refuses it", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch;
    try {
      await expect(
        resolveFileToBase64({ sourceUrl: "https://onedrive.example/share/x" }, { maxBytes: 1000, stagingDir: dir }),
      ).rejects.toThrow(/HTML page/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("downloads bytes from a non-HTML sourceUrl", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(Buffer.from("IMG"), {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as typeof fetch;
    try {
      const r = await resolveFileToBase64(
        { sourceUrl: "https://e.com/a.png" },
        { maxBytes: 1000, stagingDir: dir },
      );
      expect(r.mimeType).toBe("image/png");
      expect(Buffer.from(r.base64, "base64").toString()).toBe("IMG");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

import { writeBase64ToPath, clearStaging } from "../../src/utils/files.js";

describe("writeBase64ToPath + clearStaging", () => {
  let dir2: string;
  beforeEach(async () => {
    dir2 = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "simpro-out-"));
  });
  afterEach(async () => {
    await fsp.rm(dir2, { recursive: true, force: true });
  });

  it("writes base64 to a path, creating parent dirs, and returns the absolute path", async () => {
    const dest = nodePath.join(dir2, "nested", "out.txt");
    const abs = await writeBase64ToPath(Buffer.from("hi").toString("base64"), dest);
    expect(await fsp.readFile(abs, "utf8")).toBe("hi");
  });

  it("clearStaging removes the ref directory", async () => {
    const refDir = nodePath.join(dir2, "refToClear");
    await fsp.mkdir(refDir, { recursive: true });
    await fsp.writeFile(nodePath.join(refDir, "f.txt"), "x");
    await clearStaging(dir2, "refToClear");
    await expect(fsp.readdir(refDir)).rejects.toBeTruthy();
  });
});
