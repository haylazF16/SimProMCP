// tests/http/rateLimit.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RateLimiter } from "../../src/http/rateLimit.js";

describe("RateLimiter", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns 'ok' below the soft limit", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 3, hardLimit: 5 });
    expect(rl.check("u1")).toBe("ok");
    expect(rl.check("u1")).toBe("ok");
    expect(rl.check("u1")).toBe("ok"); // 3rd call, count=3, not > soft(3)
  });

  it("returns 'soft' the first time the soft limit is crossed, 'ok' after", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 2, hardLimit: 5 });
    expect(rl.check("u1")).toBe("ok");   // 1
    expect(rl.check("u1")).toBe("ok");   // 2 (== soft, not >)
    expect(rl.check("u1")).toBe("soft"); // 3 (> soft) -> warn once
    expect(rl.check("u1")).toBe("ok");   // 4 (> soft but already warned this window)
  });

  it("returns 'hard' once the hard limit is exceeded", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 2, hardLimit: 3 });
    rl.check("u1"); // 1
    rl.check("u1"); // 2
    rl.check("u1"); // 3 (== hard, not >)
    expect(rl.check("u1")).toBe("hard"); // 4 (> hard)
  });

  it("resets the count after the window elapses", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 1, hardLimit: 2 });
    rl.check("u1"); // 1
    rl.check("u1"); // 2 (== hard)
    expect(rl.check("u1")).toBe("hard"); // 3 (> hard)
    vi.advanceTimersByTime(1001);
    expect(rl.check("u1")).toBe("ok");   // window expired, count back to 1
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 1, hardLimit: 1 });
    rl.check("u1"); // u1 = 1 (== hard)
    expect(rl.check("u1")).toBe("hard"); // u1 = 2
    expect(rl.check("u2")).toBe("ok");   // u2 independent
  });

  it("re-arms the soft warning in a new window", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 1, hardLimit: 9 });
    rl.check("u1");                       // 1
    expect(rl.check("u1")).toBe("soft");  // 2 > soft, warn
    expect(rl.check("u1")).toBe("ok");    // 3, already warned
    vi.advanceTimersByTime(1001);
    rl.check("u1");                       // new window, 1
    expect(rl.check("u1")).toBe("soft");  // 2 > soft, warn again
  });

  it("sweep() removes keys with no recent activity", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 5, hardLimit: 9 });
    rl.check("u1");
    expect(rl.size()).toBe(1);
    vi.advanceTimersByTime(1001);
    rl.sweep();
    expect(rl.size()).toBe(0);
  });

  it("sweep() keeps keys with activity inside the window", () => {
    const rl = new RateLimiter({ windowMs: 1000, softLimit: 5, hardLimit: 9 });
    rl.check("u1");
    vi.advanceTimersByTime(500);
    rl.sweep();
    expect(rl.size()).toBe(1);
  });
});
