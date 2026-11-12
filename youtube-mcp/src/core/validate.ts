// Narrow, validated tool inputs. The model chooses the arguments, so every
// argument is checked against a pattern or a fixed list before it reaches
// Google. Platform-neutral.

import { z } from 'zod';

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** YouTube Analytics metrics this server will ask for. Anything else is refused. */
export const METRICS = [
  'views',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'averageViewPercentage',
  'subscribersGained',
  'subscribersLost',
  'likes',
  'dislikes',
  'comments',
  'shares',
  'videosAddedToPlaylists',
  'videosRemovedFromPlaylists',
  'cardClicks',
  'cardImpressions',
  'cardClickRate',
] as const;

/** YouTube Analytics dimensions this server will ask for. Anything else is refused. */
export const DIMENSIONS = [
  'day',
  'month',
  'video',
  'country',
  'deviceType',
  'operatingSystem',
  'insightTrafficSourceType',
  'insightPlaybackLocationType',
  'ageGroup',
  'gender',
  'subscribedStatus',
  'youtubeProduct',
  'creatorContentType',
] as const;

export const MAX_RANGE_DAYS = 366;
const EARLIEST = '2005-02-14'; // YouTube's founding date: nothing to report before it

export const videoId = z.string().regex(VIDEO_ID, 'video_id must be an 11-character YouTube video ID');
export const isoDate = z.string().regex(DATE, 'dates are YYYY-MM-DD');

export const analyticsInput = z.object({
  start_date: isoDate.describe('First day, YYYY-MM-DD'),
  end_date: isoDate.describe('Last day, YYYY-MM-DD, not in the future'),
  metrics: z.array(z.enum(METRICS)).min(1).max(10).describe('One to ten metrics'),
  dimensions: z.array(z.enum(DIMENSIONS)).max(2).default([]).describe('Up to two dimensions'),
  video_id: videoId.optional().describe("Limit to one of the owner's videos"),
  sort: z
    .string()
    .regex(/^-?[A-Za-z]+$/)
    .optional()
    .describe('A requested metric or dimension, prefix with - for descending'),
  max_results: z.number().int().min(1).max(200).default(50),
});
export type AnalyticsInput = z.infer<typeof analyticsInput>;

function utcDate(value: string): Date | null {
  if (!DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

/** Checks a date range is real, ordered, not in the future and not too long. Returns a problem or null. */
export function checkDateRange(start: string, end: string, today: Date = new Date()): string | null {
  const from = utcDate(start);
  const to = utcDate(end);
  if (!from || !to) return 'Dates must be real calendar dates in YYYY-MM-DD form.';
  if (start < EARLIEST) return `start_date can't be before ${EARLIEST}.`;
  if (from > to) return 'start_date must be on or before end_date.';
  if (end > today.toISOString().slice(0, 10)) return "end_date can't be in the future.";
  const days = (to.getTime() - from.getTime()) / 86_400_000 + 1;
  if (days > MAX_RANGE_DAYS) return `The range can be at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

/** sort must name one of the requested metrics or dimensions. */
export function checkSort(input: Pick<AnalyticsInput, 'sort' | 'metrics' | 'dimensions'>): string | null {
  if (!input.sort) return null;
  const key = input.sort.replace(/^-/, '');
  const allowed = new Set<string>([...input.metrics, ...input.dimensions]);
  return allowed.has(key) ? null : 'sort must be one of the requested metrics or dimensions.';
}

export function daysAgo(days: number, today: Date = new Date()): string {
  return new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}
