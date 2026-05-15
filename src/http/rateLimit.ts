// src/http/rateLimit.ts
// Pure in-memory sliding-window rate limiter, keyed by an opaque string
// (we key by the smcp_ token). No Express/HTTP coupling — server.ts adapts
// the verdict to a JSON-RPC response.
//
// Verdicts:
//   "ok"   - under the soft limit, or over it but already warned this window
//   "soft" - JUST crossed the soft limit (emit ONE warn per key per window)
//   "hard" - over the hard ceiling (caller should reject the request)

export interface RateLimiterOptions {
  windowMs: number;
  softLimit: number;
  hardLimit: number;
}

interface Entry {
  hits: number[];      // request timestamps (ms) within the window
  warnedAt: number;    // timestamp of the last soft warning, 0 if none
}

export class RateLimiter {
  private readonly opts: RateLimiterOptions;
  private readonly map = new Map<string, Entry>();

  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
  }

  /** Record a hit for `key` and return the verdict. */
  check(key: string): "ok" | "soft" | "hard" {
    const now = Date.now();
    const cutoff = now - this.opts.windowMs;
    let e = this.map.get(key);
    if (!e) {
      e = { hits: [], warnedAt: 0 };
      this.map.set(key, e);
    }
    // Drop timestamps outside the window.
    if (e.hits.length && e.hits[0] <= cutoff) {
      e.hits = e.hits.filter((t) => t > cutoff);
    }
    // If the warning was issued in a now-expired window, re-arm it.
    if (e.warnedAt !== 0 && e.warnedAt <= cutoff) {
      e.warnedAt = 0;
    }
    e.hits.push(now);
    const count = e.hits.length;

    if (count > this.opts.hardLimit) {
      return "hard";
    }
    if (count > this.opts.softLimit) {
      if (e.warnedAt === 0) {
        e.warnedAt = now;
        return "soft";
      }
      return "ok";
    }
    return "ok";
  }

  /** Remove keys whose newest hit is outside the window. Call periodically. */
  sweep(): void {
    const cutoff = Date.now() - this.opts.windowMs;
    for (const [key, e] of this.map) {
      const newest = e.hits.length ? e.hits[e.hits.length - 1] : 0;
      if (newest <= cutoff) this.map.delete(key);
    }
  }

  /** Number of tracked keys (for tests / introspection). */
  size(): number {
    return this.map.size;
  }
}
