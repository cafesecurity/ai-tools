// Rate limiting, to protect the owner's YouTube API quota from a runaway or
// manipulated agent. Platform-neutral interface; each platform supplies the
// strongest limiter it has and falls back to this in-memory one.

export interface RateLimiter {
  /** True if the call may go ahead. */
  allow(key: string): Promise<boolean>;
}

/**
 * Fixed one-minute window held in memory. On serverless platforms memory is
 * per instance, so this is a best-effort ceiling, not a guarantee: a platform
 * limiter (see the Workers adapter) is preferred where one exists.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  async allow(key: string): Promise<boolean> {
    const now = this.now();
    const current = this.windows.get(key);
    if (!current || now - current.start >= 60_000) {
      if (this.windows.size > 1_000) this.windows.clear(); // bounded memory; one owner means few keys
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (current.count >= this.perMinute) return false;
    current.count += 1;
    return true;
  }
}
