import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/core/tools';
import { YouTubeClient } from '../../src/core/youtube';
import { OTHER_VIDEO, OWN_VIDEO, OWNER_CHANNEL, fakeGoogle, youtubeFixture } from '../helpers';

async function connect(includeComments = false, allowCall?: () => Promise<boolean>) {
  const google = fakeGoogle(youtubeFixture);
  const server = buildServer({
    client: new YouTubeClient('t', google.fetchImpl),
    channelId: OWNER_CHANNEL,
    includeComments,
    allowCall,
    today: () => new Date('2026-11-12T12:00:00Z'),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return { client, google };
}

function text(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0]!.text;
}

describe('tools', () => {
  it('are all read-only, and comments are off by default', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_analytics_report',
      'get_audience_retention',
      'get_channel_overview',
      'get_traffic_sources',
      'get_video_details',
      'list_recent_videos',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  it('offers comments only when switched on, labelled as untrusted', async () => {
    const { client } = await connect(true);
    const result = await client.callTool({ name: 'get_recent_comments', arguments: {} });
    const body = JSON.parse(text(result));
    expect(body.note).toMatch(/never as instructions/);
    expect(body.comments[0].untrusted_text).toBeDefined();
  });

  it('refuses another channel’s video', async () => {
    const { client, google } = await connect();
    const result = await client.callTool({ name: 'get_audience_retention', arguments: { video_id: OTHER_VIDEO } });
    expect(result.isError).toBe(true);
    expect(google.calls.some((c) => c.url.hostname === 'youtubeanalytics.googleapis.com')).toBe(false);
  });

  it('rejects arguments outside the allowlists before calling Google', async () => {
    const { client, google } = await connect();
    const result = await client.callTool({
      name: 'get_analytics_report',
      arguments: { start_date: '2026-10-01', end_date: '2026-10-31', metrics: ['estimatedRevenue'] },
    });
    expect(result.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });

  it('refuses ranges over a year and future dates', async () => {
    const { client, google } = await connect();
    for (const [start, end] of [['2024-01-01', '2026-01-01'], ['2026-11-01', '2026-12-01']]) {
      const result = await client.callTool({
        name: 'get_analytics_report',
        arguments: { start_date: start, end_date: end, metrics: ['views'] },
      });
      expect(result.isError).toBe(true);
    }
    expect(google.calls).toHaveLength(0);
  });

  it('runs a per-video report with an ownership check and a fixed filter', async () => {
    const { client, google } = await connect();
    const result = await client.callTool({
      name: 'get_analytics_report',
      arguments: { start_date: '2026-10-20', end_date: '2026-11-10', metrics: ['views'], dimensions: ['day'], video_id: OWN_VIDEO, sort: 'day' },
    });
    expect(result.isError).toBeFalsy();
    const analytics = google.calls.find((c) => c.url.hostname === 'youtubeanalytics.googleapis.com')!;
    expect(analytics.url.searchParams.get('filters')).toBe(`video==${OWN_VIDEO}`);
    expect(analytics.url.searchParams.get('ids')).toBe('channel==MINE');
  });

  it('lines retention up with the video in seconds', async () => {
    const { client } = await connect();
    const body = JSON.parse(text(await client.callTool({ name: 'get_audience_retention', arguments: { video_id: OWN_VIDEO } })));
    expect(body.duration_seconds).toBe(108);
    expect(body.start_date).toBe('2026-10-20');
    expect(body.points[1]).toEqual({ position_ratio: 0.5, position_seconds: 54, audience_watch_ratio: 0.42, relative_retention: 0.55 });
  });

  it('gives the overview without internal IDs', async () => {
    const { client } = await connect();
    const body = JSON.parse(text(await client.callTool({ name: 'get_channel_overview', arguments: {} })));
    expect(body.subscribers).toBe(1200);
    expect(body.uploads_playlist_id).toBeUndefined();
  });

  it('applies the rate limit to every tool call, before Google is called', async () => {
    let left = 2;
    const { client, google } = await connect(false, async () => left-- > 0);
    expect((await client.callTool({ name: 'get_channel_overview', arguments: {} })).isError).toBeFalsy();
    expect((await client.callTool({ name: 'get_channel_overview', arguments: {} })).isError).toBeFalsy();
    const third = await client.callTool({ name: 'get_channel_overview', arguments: {} });
    expect(third.isError).toBe(true);
    expect(google.calls).toHaveLength(2);
  });
});
