/** Strip undefined/null/empty-string fields. Useful for PATCH payloads. */
export function pruneEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const nested = pruneEmpty(v as Record<string, unknown>);
      if (Object.keys(nested).length > 0) out[k] = nested;
      continue;
    }
    out[k] = v;
  }
  return out as Partial<T>;
}

/** Truncate a long string for previews. */
export function truncate(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [+${s.length - max} chars]`;
}

/**
 * Strip HTML tags + decode the most common entities + collapse whitespace.
 * Simpro stores quote/job Descriptions as huge HTML email-template blobs;
 * users want a short readable preview, not raw markup. Use only for previews.
 */
export function stripHtml(s: string | undefined | null, max = 200): string {
  if (!s) return "";
  const noTags = String(s)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z]+;/gi, " ");
  const collapsed = decoded.replace(/\s+/g, " ").trim();
  return truncate(collapsed, max);
}
