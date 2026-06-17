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

const HTML_CONTENT_TYPE = /text\/html|application\/xhtml/i;

/**
 * Resolve exactly one upload source to base64 bytes, enforcing the size guard.
 * Throws a clear, user-facing Error on any failure (the tool layer turns these
 * into per-file results so a batch continues past one bad file).
 */
export async function resolveFileToBase64(
  source: FileSource,
  opts: { maxBytes: number; stagingDir: string },
): Promise<ResolvedFile> {
  const which = pickSource(source);
  let bytes: Buffer;
  let mimeType = "application/octet-stream";
  let filename = deriveFilename(source);

  if (which === "sourceUrl") {
    const res = await fetch(source.sourceUrl as string);
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
    bytes = await fs.readFile(source.filePath as string);
    mimeType = guessMime(filename);
  } else {
    const dir = stagingPathForRef(opts.stagingDir, source.stagingRef as string);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
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
