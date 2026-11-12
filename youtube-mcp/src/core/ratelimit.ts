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
 * limiter (see the Workers adapter) is preferred where one exists. Use a
 * separate instance per purpose, so anonymous traffic can't affect the owner's limit.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  private evictExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= 60_000) this.windows.delete(key);
    }
  }

  async allow(key: string): Promise<boolean> {
    const now = this.now();
    const current = this.windows.get(key);
    if (!current || now - current.start >= 60_000) {
      if (this.windows.size >= this.maxKeys) this.evictExpired(now);
      if (this.windows.size >= this.maxKeys) return false; // full of live windows: refuse new keys, never reset existing ones
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (current.count >= this.perMinute) return false;
    current.count += 1;
    return true;
  }
}
