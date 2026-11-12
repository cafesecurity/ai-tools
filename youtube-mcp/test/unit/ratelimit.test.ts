import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../../src/core/ratelimit';

describe('MemoryRateLimiter', () => {
  it('allows N per minute per key, then resets', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(2, () => now);
    expect(await limiter.allow('a')).toBe(true);
    expect(await limiter.allow('a')).toBe(true);
    expect(await limiter.allow('a')).toBe(false);
    expect(await limiter.allow('b')).toBe(true);
    now = 60_000;
    expect(await limiter.allow('a')).toBe(true);
  });
});
