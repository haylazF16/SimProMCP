// src/http/auditReader.ts
//
// Reads audit entries from the current `audit.log` AND from monthly gzipped
// archives (created by scripts/backup.sh on the 1st of each month) so the
// admin dashboard can search history beyond the live file.
//
// Layout this assumes (matches scripts/backup.sh):
//   <auditFile>                                e.g. /opt/simpro-mcp/audit.log
//   <auditDir>/backups/audit/audit-YYYY-MM.log.gz   monthly archives, forever
//
// We expose two read modes:
//   1. tailLatest(file, n)            — cheap, no archive scan; default page
//   2. readRange(file, from, to, cap) — pulls from current + archives whose
//                                       YYYY-MM overlaps the range.

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

/** Read up to `n` last non-empty lines from `file`. Missing file = []. */
export function tailLatest(file: string, n: number): string[] {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Enumerate "YYYY-MM" month tags between two dates, inclusive.
 * Used to pick which monthly archive files to open.
 */
function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  // Guard against pathological inputs — cap at 240 months (20 years).
  for (let i = 0; cur <= end && i < 240; i++) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    out.push(`${y}-${m}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

/** Parse the "ts" field from a JSON audit line. NaN if malformed. */
function lineTs(line: string): number {
  // Quick reject without full parse: must contain "ts":"
  const at = line.indexOf('"ts":"');
  if (at < 0) return NaN;
  const start = at + 6;
  const end = line.indexOf('"', start);
  if (end < 0) return NaN;
  const t = Date.parse(line.slice(start, end));
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Read audit entries whose timestamp falls in [fromMs, toMs]. Pulls from the
 * current audit.log plus every monthly archive whose YYYY-MM overlaps the
 * range. Returns lines in chronological order (oldest first); the caller
 * typically reverses to display newest first. Caps at `cap` lines to bound
 * memory/page weight (newest `cap` lines kept when truncating).
 */
export function readRange(
  currentFile: string,
  from: Date,
  to: Date,
  cap: number,
): { lines: string[]; truncated: boolean; sourcesRead: string[] } {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const sourcesRead: string[] = [];
  const matched: string[] = [];

  // Each monthly archive sits next to the current file: <dir>/backups/audit/...
  // We accept both same-dir and ../backups/audit relative layouts; the real
  // layout is currentFile=/opt/simpro-mcp/audit.log and archives in
  // /opt/simpro-mcp/backups/audit/. Derive from currentFile's directory.
  const baseDir = path.dirname(path.resolve(currentFile));
  const archiveDir = path.join(baseDir, "backups", "audit");

  const months = monthsBetween(from, to);
  for (const ym of months) {
    const archive = path.join(archiveDir, `audit-${ym}.log.gz`);
    if (!fs.existsSync(archive)) continue;
    try {
      const buf = fs.readFileSync(archive);
      const text = zlib.gunzipSync(buf).toString("utf8");
      sourcesRead.push(path.basename(archive));
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        const t = lineTs(line);
        if (Number.isFinite(t) && t >= fromMs && t <= toMs) matched.push(line);
      }
    } catch {
      // skip unreadable / corrupt archives — best-effort
    }
  }

  // Always scan the live file too (covers current partial month and any
  // entries that haven't been archived yet).
  try {
    const text = fs.readFileSync(currentFile, "utf8");
    sourcesRead.push(path.basename(currentFile));
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const t = lineTs(line);
      if (Number.isFinite(t) && t >= fromMs && t <= toMs) matched.push(line);
    }
  } catch {
    // current file may not exist on a brand-new install
  }

  // Sort chronologically. Each line has a sortable ISO ts, so a simple
  // numeric sort on parsed ts is correct and stable enough.
  matched.sort((a, b) => lineTs(a) - lineTs(b));

  const truncated = matched.length > cap;
  const lines = truncated ? matched.slice(matched.length - cap) : matched;
  return { lines, truncated, sourcesRead };
}
