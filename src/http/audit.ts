// Append-only audit log of every authenticated MCP request.
//
// One JSON object per line (JSONL) so the file is greppable + tail-able
// without a parser. Format:
//   {"ts":"2026-05-04T...","user":"Tayfun","company":"plumbing","tool":"...","ok":true,"ms":123}
//
// Args are NOT logged (could contain sensitive customer data); only the
// tool name + duration + success bit. If you need full args for forensic
// debugging, raise the log level via SIMPRO_DEBUG=true and look at stderr.

import fs from "node:fs";
import path from "node:path";

let openStream: fs.WriteStream | null = null;
let openPath: string | null = null;

function getStream(filePath: string): fs.WriteStream {
  if (openStream && openPath === filePath) return openStream;
  if (openStream) openStream.end();
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  openStream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  openPath = filePath;
  return openStream;
}

export interface AuditEntry {
  user: string;
  company: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  errorMessage?: string;
}

export function recordAudit(filePath: string, e: AuditEntry): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n";
    getStream(filePath).write(line);
  } catch {
    // Best-effort — never fail a real tool call because of an audit write.
  }
}
