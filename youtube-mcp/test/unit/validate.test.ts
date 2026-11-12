import { describe, expect, it } from 'vitest';
import { analyticsInput, checkDateRange, checkSort } from '../../src/core/validate';

const TODAY = new Date('2026-11-12T12:00:00Z');

describe('checkDateRange', () => {
  it('accepts a normal range', () => {
    expect(checkDateRange('2026-10-01', '2026-11-10', TODAY)).toBeNull();
  });
  it.each([
    ['2026-02-30', '2026-03-01', 'real calendar'],
    ['2026-11-10', '2026-11-01', 'on or before'],
    ['2026-11-01', '2026-11-13', 'future'],
    ['2004-01-01', '2004-02-01', "can't be before"],
    ['2025-01-01', '2026-11-01', 'at most'],
  ])('refuses %s to %s', (start, end, message) => {
    expect(checkDateRange(start, end, TODAY)).toContain(message);
  });
});

describe('analyticsInput', () => {
  const valid = { start_date: '2026-10-01', end_date: '2026-10-31', metrics: ['views'] };
  it('applies defaults', () => {
    const parsed = analyticsInput.parse(valid);
    expect(parsed.dimensions).toEqual([]);
    expect(parsed.max_results).toBe(50);
  });
  it.each([
    [{ metrics: ['views;DROP'] }],
    [{ metrics: ['estimatedRevenue'] }], // money metrics are deliberately not offered
    [{ metrics: [] }],
    [{ dimensions: ['day', 'video', 'country'] }],
    [{ dimensions: ['channel'] }],
    [{ video_id: 'abc' }],
    [{ video_id: 'AAAAAAAAAAA,BBBBBBBBBBB' }],
    [{ sort: 'views,likes' }],
    [{ max_results: 10_000 }],
    [{ start_date: '01/10/2026' }],
  ])('refuses %j', (patch) => {
    expect(analyticsInput.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe('checkSort', () => {
  it('requires sort to be one of the requested fields', () => {
    expect(checkSort({ sort: '-views', metrics: ['views'], dimensions: [] })).toBeNull();
    expect(checkSort({ sort: 'likes', metrics: ['views'], dimensions: [] })).not.toBeNull();
  });
});
