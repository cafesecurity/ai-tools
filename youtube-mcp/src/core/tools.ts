// The MCP tools. All read-only, all scoped to the signed-in owner's channel,
// all with validated inputs and capped outputs. Platform-neutral.

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { UpstreamError } from './http';
import { logEvent } from './log';
import { UNTRUSTED_NOTE } from './untrusted';
import { analyticsInput, checkDateRange, checkSort, daysAgo, isoDate, videoId } from './validate';
import type { YouTubeClient } from './youtube';

export const SERVER_NAME = 'youtube-analytics-readonly';
export const SERVER_VERSION = '0.1.0';
const MAX_RESULT_CHARS = 60_000;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export interface ToolDeps {
  client: YouTubeClient;
  /** The owner's channel, resolved at sign-in. Every call is limited to it. */
  channelId: string;
  /** Off unless the operator sets ENABLE_COMMENTS=true: keeps strangers' text away from agents by default. */
  includeComments: boolean;
  today?: () => Date;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  if (text.length > MAX_RESULT_CHARS) {
    return fail('The result is too large. Narrow the date range, use fewer dimensions, or lower max_results.');
  }
  return { content: [{ type: 'text', text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function guarded(tool: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UpstreamError) {
      logEvent('tool_error', { tool, kind: error.kind, status: error.status });
      return fail(error.detail ? `${error.message} ${error.detail}` : error.message);
    }
    logEvent('tool_error', { tool, kind: 'internal' });
    return fail('Something went wrong on the server.');
  }
}

export function buildServer(deps: ToolDeps): McpServer {
  const today = deps.today ?? (() => new Date());
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only analytics for the signed-in owner's YouTube channel. Nothing here can change the channel. " +
        UNTRUSTED_NOTE,
      maxToolInputElements: 100,
    },
  );

  server.registerTool(
    'get_channel_overview',
    {
      title: 'Channel overview',
      description: "The owner's channel: title, handle, subscribers (null if hidden), total views and video count.",
      annotations: READ_ONLY,
    },
    async () =>
      guarded('get_channel_overview', async () => {
        const { uploads_playlist_id: _uploads, ...channel } = await deps.client.myChannel();
        return ok(channel);
      }),
  );

  server.registerTool(
    'list_recent_videos',
    {
      title: 'Recent uploads',
      description:
        'The most recent uploads with public counts: views, likes, comments, duration. likely_short marks videos of three minutes or less.',
      inputSchema: z.object({ max_results: z.number().int().min(1).max(50).default(20) }),
      annotations: READ_ONLY,
    },
    async ({ max_results }) =>
      guarded('list_recent_videos', async () => {
        const channel = await deps.client.myChannel();
        return ok({ videos: await deps.client.recentUploads(channel.uploads_playlist_id, max_results) });
      }),
  );

  server.registerTool(
    'get_video_details',
    {
      title: 'Video details',
      description: "Public counts and details for one of the owner's videos.",
      inputSchema: z.object({ video_id: videoId }),
      annotations: READ_ONLY,
    },
    async ({ video_id }) =>
      guarded('get_video_details', async () => ok(await deps.client.ownedVideo(video_id, deps.channelId))),
  );

  server.registerTool(
    'get_analytics_report',
    {
      title: 'Analytics report',
      description:
        "A YouTube Analytics report for the owner's channel (or one of its videos). Metrics and dimensions come from fixed lists. " +
        'Data usually lags by two or three days. Not every combination is supported by YouTube; if one is refused, the error says why.',
      inputSchema: analyticsInput,
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded('get_analytics_report', async () => {
        const problem = checkDateRange(input.start_date, input.end_date, today()) ?? checkSort(input);
        if (problem) return fail(problem);
        if (input.video_id) await deps.client.ownedVideo(input.video_id, deps.channelId);
        const report = await deps.client.analytics({
          startDate: input.start_date,
          endDate: input.end_date,
          metrics: input.metrics,
          dimensions: input.dimensions,
          filters: input.video_id ? `video==${input.video_id}` : undefined,
          sort: input.sort,
          maxResults: input.max_results,
        });
        return ok(report);
      }),
  );

  server.registerTool(
    'get_audience_retention',
    {
      title: 'Audience retention',
      description:
        "How much of one of the owner's videos viewers watched, at 100 points through it. position_seconds lets you line it up with a script. " +
        'audience_watch_ratio is the share of viewers still watching (it can exceed 1 where people rewatch); relative_retention compares with similar videos (0 to 1, 0.5 is typical).',
      inputSchema: z.object({
        video_id: videoId,
        start_date: isoDate.optional().describe('Defaults to the publish date, or a year ago for older videos'),
        end_date: isoDate.optional().describe('Defaults to today'),
      }),
      annotations: READ_ONLY,
    },
    async ({ video_id, start_date, end_date }) =>
      guarded('get_audience_retention', async () => {
        const video = await deps.client.ownedVideo(video_id, deps.channelId);
        const now = today();
        const end = end_date ?? now.toISOString().slice(0, 10);
        const published = video.published_at.slice(0, 10);
        const yearAgo = daysAgo(365, now);
        const start = start_date ?? (published > yearAgo ? published : yearAgo);
        const problem = checkDateRange(start, end, now);
        if (problem) return fail(problem);
        const report = await deps.client.analytics({
          startDate: start,
          endDate: end,
          metrics: ['audienceWatchRatio', 'relativeRetentionPerformance'],
          dimensions: ['elapsedVideoTimeRatio'],
          filters: `video==${video_id}`,
        });
        const points = report.rows.map(([ratio, watch, relative]) => ({
          position_ratio: Number(ratio),
          position_seconds: Math.round(Number(ratio) * video.duration_seconds * 10) / 10,
          audience_watch_ratio: Number(watch),
          relative_retention: Number(relative),
        }));
        return ok({ video_id, title: video.title, duration_seconds: video.duration_seconds, start_date: start, end_date: end, points });
      }),
  );

  server.registerTool(
    'get_traffic_sources',
    {
      title: 'Traffic sources',
      description: 'Where views came from (search, browse, Shorts feed, external sites and so on), for the channel or one video.',
      inputSchema: z.object({
        start_date: isoDate.optional().describe('Defaults to 28 days ago'),
        end_date: isoDate.optional().describe('Defaults to today'),
        video_id: videoId.optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, video_id }) =>
      guarded('get_traffic_sources', async () => {
        const now = today();
        const start = start_date ?? daysAgo(28, now);
        const end = end_date ?? now.toISOString().slice(0, 10);
        const problem = checkDateRange(start, end, now);
        if (problem) return fail(problem);
        if (video_id) await deps.client.ownedVideo(video_id, deps.channelId);
        const report = await deps.client.analytics({
          startDate: start,
          endDate: end,
          metrics: ['views', 'estimatedMinutesWatched'],
          dimensions: ['insightTrafficSourceType'],
          filters: video_id ? `video==${video_id}` : undefined,
          sort: '-views',
        });
        return ok({ start_date: start, end_date: end, ...report });
      }),
  );

  if (deps.includeComments) {
    server.registerTool(
      'get_recent_comments',
      {
        title: 'Recent comments',
        description:
          "Recent top-level comments on the owner's channel or one video, newest first, without authors' names. " + UNTRUSTED_NOTE,
        inputSchema: z.object({
          video_id: videoId.optional(),
          max_results: z.number().int().min(1).max(50).default(20),
        }),
        annotations: READ_ONLY,
      },
      async ({ video_id, max_results }) =>
        guarded('get_recent_comments', async () => {
          if (video_id) await deps.client.ownedVideo(video_id, deps.channelId);
          const comments = await deps.client.comments({ channelId: deps.channelId, videoId: video_id, max: max_results });
          return ok({ note: UNTRUSTED_NOTE, comments });
        }),
    );
  }

  return server;
}
