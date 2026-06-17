import path from "node:path";
import { promises as fs } from "node:fs";

export interface FileSource {
  sourceUrl?: string;
  filePath?: string;
  stagingRef?: string;
  filename?: string;
}

export interface ResolvedFile {
  filename: string;
  base64: string;
  mimeType: string;
  sizeBytes: number;
}

const SOURCE_KEYS = ["sourceUrl", "filePath", "stagingRef"] as const;
type SourceKey = (typeof SOURCE_KEYS)[number];

/** Return the single populated source key, or throw if not exactly one. */
export function pickSource(file: FileSource): SourceKey {
  const set = SOURCE_KEYS.filter(
    (k) => typeof file[k] === "string" && (file[k] as string).trim() !== "",
  );
  if (set.length === 0) {
    throw new Error("Each file needs exactly one of sourceUrl, filePath or stagingRef — none were given.");
  }
  if (set.length > 1) {
    throw new Error(`Each file needs exactly one source, but got ${set.length}: ${set.join(", ")}.`);
  }
  return set[0];
}

/** Best-effort filename: explicit override wins, else the URL/path basename. */
export function deriveFilename(source: FileSource): string {
  if (source.filename && source.filename.trim()) return source.filename.trim();
  let raw = "";
  if (source.sourceUrl) {
    try {
      raw = new URL(source.sourceUrl).pathname;
    } catch {
      raw = source.sourceUrl;
    }
  } else {
    raw = source.filePath ?? source.stagingRef ?? "";
  }
  const base = path.basename(raw.split("?")[0]);
  return base || "upload.bin";
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Guess a MIME type from a filename extension. */
export function guessMime(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/** Resolve a staging ref to its directory, rejecting traversal / bad tokens. */
export function stagingPathForRef(stagingDir: string, ref: string): string {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(ref)) {
    throw new Error(`Invalid staging ref "${ref}".`);
  }
  return path.join(stagingDir, ref);
}

/**
 * Resolve `candidate` (relative or absolute) to an absolute path GUARANTEED to
 * sit inside `baseDir`, or throw. Used to confine multi-user filesystem writes
 * so a caller-supplied path can never escape (via "..", an absolute path, or a
 * symlink-style sequence) to clobber server files. A candidate that resolves to
 * baseDir itself (no filename) is also rejected.
 */
export function confineWithin(baseDir: string, candidate: string): string {
  const baseAbs = path.resolve(baseDir);
  // path.resolve lets an absolute candidate override baseAbs entirely, which is
  // exactly the escape we then detect via the relative-path check below.
  const destAbs = path.resolve(baseAbs, candidate);
  const rel = path.relative(baseAbs, destAbs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to write "${candidate}" outside the allowed directory ${baseAbs}.`,
    );
  }
  return destAbs;
}

const HTML_CONTENT_TYPE = /text\/html|application\/xhtml/i;

/**
 * Block the obvious server-side-request-forgery targets before fetching a
 * caller-supplied sourceUrl: non-http(s) schemes and literal loopback / private
 * / link-local hosts (incl. the cloud-metadata IP). This is defence-in-depth on
 * top of write-gating; it does NOT resolve DNS, so a hostname that resolves to a
 * private IP (DNS rebinding) is a documented residual — pair with a network
 * egress policy for full coverage.
 */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./, // link-local incl. 169.254.169.254 cloud metadata
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^::ffff:127\./i,
  /^f[cd][0-9a-f]{2}:/i, // fc00::/7 unique-local
  /^fe80:/i, // link-local
  /\.internal$/i, // metadata.google.internal & friends
];

export function assertFetchableUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`sourceUrl is not a valid URL: "${raw}".`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`sourceUrl must use http or https, not "${u.protocol}".`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new Error(
      `sourceUrl host "${u.hostname}" is a loopback/private/link-local address and is not allowed.`,
    );
  }
  return u;
}

/**
 * Resolve exactly one upload source to base64 bytes, enforcing the size guard.
 * Throws a clear, user-facing Error on any failure (the tool layer turns these
 * into per-file results so a batch continues past one bad file).
 */
export async function resolveFileToBase64(
  source: FileSource,
  opts: { maxBytes: number; stagingDir: string; transport?: string },
): Promise<ResolvedFile> {
  const which = pickSource(source);
  let bytes: Buffer;
  let mimeType = "application/octet-stream";
  let filename = deriveFilename(source);

  if (which === "sourceUrl") {
    assertFetchableUrl(source.sourceUrl as string);
    // Bound the fetch so an unresponsive host can't hang the request forever.
    const res = await fetch(source.sourceUrl as string, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`Could not download sourceUrl (HTTP ${res.status}). Use a direct-download link.`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (HTML_CONTENT_TYPE.test(ct)) {
      throw new Error(
        "sourceUrl returned an HTML page, not a file. OneDrive/SharePoint 'share' links open a " +
        "viewer — use a direct-download link (e.g. one ending in ?download=1).",
      );
    }
    bytes = Buffer.from(await res.arrayBuffer());
    if (ct) mimeType = ct.split(";")[0].trim();
  } else if (which === "filePath") {
    // filePath reads arbitrary server-side files. That is fine on a single-user
    // STDIO install (the caller's own machine) but is a local-file-disclosure
    // vector on the shared HTTP server, so it is disabled there — remote users
    // must drop a file on the portal (stagingRef) or pass a sourceUrl.
    if (opts.transport === "http") {
      throw new Error(
        "filePath uploads are disabled on the shared server. Drop the file on the portal " +
        "(use its stagingRef) or pass a direct-download sourceUrl instead.",
      );
    }
    bytes = await fs.readFile(source.filePath as string);
    mimeType = guessMime(filename);
  } else {
    const dir = stagingPathForRef(opts.stagingDir, source.stagingRef as string);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code && code !== "ENOENT") {
        // A real FS fault (permissions, too many open files, not-a-dir) is NOT
        // the same as an expired ref — surface it so the operator fixes the
        // right thing instead of chasing a phantom "expired" message.
        throw new Error(`Staging ref "${source.stagingRef}" could not be read (${code}).`);
      }
      throw new Error(`Staging ref "${source.stagingRef}" not found or expired.`);
    }
    const fileName = entries.find((e) => !e.startsWith("."));
    if (!fileName) throw new Error(`Staging ref "${source.stagingRef}" has no file.`);
    filename = source.filename?.trim() || fileName;
    bytes = await fs.readFile(path.join(dir, fileName));
    mimeType = guessMime(filename);
  }

  if (bytes.byteLength > opts.maxBytes) {
    throw new Error(
      `File "${filename}" is ${(bytes.byteLength / 1_048_576).toFixed(1)} MB, over the ` +
      `${(opts.maxBytes / 1_048_576).toFixed(0)} MB limit (SIMPRO_MAX_ATTACHMENT_MB).`,
    );
  }
  return { filename, base64: bytes.toString("base64"), mimeType, sizeBytes: bytes.byteLength };
}

/**
 * Decode base64 and write it to destPath (creating parent dirs). Returns the
 * absolute path. With `exclusive: true` the write uses the "wx" flag, so an
 * existing file is never silently overwritten (EEXIST surfaces as an error) —
 * used on the confined HTTP download path as belt-and-braces against clobber.
 */
export async function writeBase64ToPath(
  base64: string,
  destPath: string,
  opts: { exclusive?: boolean } = {},
): Promise<string> {
  const abs = path.resolve(destPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.writeFile(abs, Buffer.from(base64, "base64"), opts.exclusive ? { flag: "wx" } : undefined);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(`A file already exists at ${abs}; refusing to overwrite it.`);
    }
    throw e;
  }
  return abs;
}

/** Remove a staging ref directory after a successful upload. Best-effort. */
export async function clearStaging(stagingDir: string, ref: string): Promise<void> {
  const dir = stagingPathForRef(stagingDir, ref);
  await fs.rm(dir, { recursive: true, force: true });
}
