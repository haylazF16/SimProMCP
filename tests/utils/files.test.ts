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

  it("clearStaging on a missing ref is a no-op (does not throw)", async () => {
    await expect(clearStaging(dir2, "neverExisted")).resolves.toBeUndefined();
  });

  it("refuses to overwrite an existing file when exclusive:true", async () => {
    const dest = nodePath.join(dir2, "once.txt");
    await writeBase64ToPath(Buffer.from("first").toString("base64"), dest, { exclusive: true });
    await expect(
      writeBase64ToPath(Buffer.from("second").toString("base64"), dest, { exclusive: true }),
    ).rejects.toThrow(/already exists/i);
    // The original bytes are untouched.
    expect(await fsp.readFile(dest, "utf8")).toBe("first");
  });
});

import { confineWithin, assertFetchableUrl } from "../../src/utils/files.js";

describe("confineWithin (multi-user write confinement)", () => {
  it("resolves a relative candidate to an absolute path inside the base dir", () => {
    const abs = confineWithin("/srv/downloads", "inv/a.pdf");
    expect(nodePath.isAbsolute(abs)).toBe(true);
    expect(abs).toBe(nodePath.resolve("/srv/downloads", "inv/a.pdf"));
  });

  it("rejects an absolute candidate that escapes the base dir", () => {
    expect(() => confineWithin("/srv/downloads", "/etc/passwd")).toThrow(/outside the allowed directory/i);
  });

  it("rejects a '..' traversal that escapes the base dir", () => {
    expect(() => confineWithin("/srv/downloads", "../secrets/.env")).toThrow(/outside the allowed directory/i);
  });

  it("rejects a candidate that resolves to the base dir itself (no filename)", () => {
    expect(() => confineWithin("/srv/downloads", ".")).toThrow(/outside the allowed directory/i);
  });
});

describe("assertFetchableUrl (SSRF guard)", () => {
  it("accepts ordinary http(s) URLs and returns a URL", () => {
    expect(assertFetchableUrl("https://files.example.com/a.pdf")).toBeInstanceOf(URL);
    expect(assertFetchableUrl("http://files.example.com/a.pdf").hostname).toBe("files.example.com");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertFetchableUrl("file:///etc/passwd")).toThrow(/http or https/i);
    expect(() => assertFetchableUrl("ftp://host/x")).toThrow(/http or https/i);
  });

  it("rejects a malformed URL", () => {
    expect(() => assertFetchableUrl("not a url")).toThrow(/not a valid URL/i);
  });

  it("rejects loopback / private / link-local hosts (incl. cloud metadata)", () => {
    for (const u of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.10/x",
      "http://169.254.169.254/latest/meta-data/", // AWS metadata
      "http://172.16.0.1/x",
      "http://[::1]/x",
      "http://metadata.google.internal/x",
    ]) {
      expect(() => assertFetchableUrl(u), u).toThrow(/loopback|private|link-local/i);
    }
  });
});

describe("resolveFileToBase64 — transport + sourceUrl edges", () => {
  let dir3: string;
  beforeEach(async () => {
    dir3 = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "simpro-edge-"));
  });
  afterEach(async () => {
    await fsp.rm(dir3, { recursive: true, force: true });
  });

  it("disables filePath uploads in HTTP (multi-user) mode", async () => {
    const p = nodePath.join(dir3, "secret.txt");
    await fsp.writeFile(p, "hi");
    await expect(
      resolveFileToBase64({ filePath: p }, { maxBytes: 1000, stagingDir: dir3, transport: "http" }),
    ).rejects.toThrow(/disabled on the shared server/i);
  });

  it("still reads filePath in STDIO mode (transport unset or 'stdio')", async () => {
    const p = nodePath.join(dir3, "ok.txt");
    await fsp.writeFile(p, "ok");
    const r = await resolveFileToBase64({ filePath: p }, { maxBytes: 1000, stagingDir: dir3, transport: "stdio" });
    expect(Buffer.from(r.base64, "base64").toString()).toBe("ok");
  });

  it("blocks a private-host sourceUrl before any fetch happens", async () => {
    const realFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("x", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        resolveFileToBase64({ sourceUrl: "http://169.254.169.254/x" }, { maxBytes: 1000, stagingDir: dir3 }),
      ).rejects.toThrow(/loopback|private|link-local/i);
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("surfaces an HTTP error from sourceUrl", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    try {
      await expect(
        resolveFileToBase64({ sourceUrl: "https://e.com/missing.pdf" }, { maxBytes: 1000, stagingDir: dir3 }),
      ).rejects.toThrow(/HTTP 404/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("uses an explicit filename override (and its mime) for a staged file", async () => {
    const refDir = nodePath.join(dir3, "ref99XYZ12");
    await fsp.mkdir(refDir, { recursive: true });
    await fsp.writeFile(nodePath.join(refDir, "original.bin"), "DATA");
    const r = await resolveFileToBase64(
      { stagingRef: "ref99XYZ12", filename: "renamed.docx" },
      { maxBytes: 1000, stagingDir: dir3 },
    );
    expect(r.filename).toBe("renamed.docx");
    expect(r.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("ignores dotfiles in a staging dir and reports no file", async () => {
    const refDir = nodePath.join(dir3, "refDot1234");
    await fsp.mkdir(refDir, { recursive: true });
    await fsp.writeFile(nodePath.join(refDir, ".keep"), "");
    await expect(
      resolveFileToBase64({ stagingRef: "refDot1234" }, { maxBytes: 1000, stagingDir: dir3 }),
    ).rejects.toThrow(/has no file/i);
  });
});

describe("deriveFilename fallbacks", () => {
  it("falls back to upload.bin for a directory-style URL and an empty source", () => {
    expect(deriveFilename({ sourceUrl: "https://e.com/" })).toBe("upload.bin");
    expect(deriveFilename({})).toBe("upload.bin");
  });

  it("returns the ref token for a bare stagingRef (the tool layer masks this)", () => {
    expect(deriveFilename({ stagingRef: "ref123ABC" })).toBe("ref123ABC");
  });
});
