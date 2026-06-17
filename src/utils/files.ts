import path from "node:path";

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
