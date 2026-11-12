// Read-only calls to the YouTube Data API and the YouTube Analytics API, always
// for the signed-in owner's own channel. Platform-neutral.

import { callGoogle, type FetchLike, googleErrorMessage, googleErrorReason, UpstreamError } from './http';
import { plainText } from './untrusted';

const DATA_API = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports';

export interface Channel {
  channel_id: string;
  title: string;
  handle: string;
  created_at: string;
  subscribers: number | null; // null when the owner hides the count
  total_views: number;
  video_count: number;
  uploads_playlist_id: string;
}

export interface Video {
  video_id: string;
  title: string;
  published_at: string;
  duration_seconds: number;
  likely_short: boolean;
  views: number;
  likes: number | null;
  comments: number | null;
  privacy: string;
}

export interface Comment {
  published_at: string;
  likes: number;
  replies: number;
  video_id: string;
  untrusted_text: string;
}

export interface Report {
  columns: string[];
  rows: Array<Array<string | number>>;
}

const num = (value: unknown): number => (typeof value === 'string' || typeof value === 'number' ? Number(value) || 0 : 0);

/** ISO 8601 duration (PT1H2M3S) to seconds. */
export function durationSeconds(iso: unknown): number {
  if (typeof iso !== 'string') return 0;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!match) return 0;
  const part = (i: number) => Number(match[i] ?? 0);
  return part(1) * 86_400 + part(2) * 3_600 + part(3) * 60 + part(4);
}

export class YouTubeClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async get(base: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const { status, json } = await callGoogle(this.fetchImpl, url, {
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' },
    });
    if (status === 200) return json;
    const reason = googleErrorReason(json);
    if (status === 401) throw new UpstreamError('auth', 'Google access has expired or was revoked. Reconnect the server.', status);
    if (status === 403 && /quota|rateLimit/i.test(reason)) throw new UpstreamError('quota', 'The YouTube API quota is used up for now. Try again later.', status);
    if (status === 403) throw new UpstreamError('forbidden', 'YouTube refused this request.', status);
    if (status === 404) throw new UpstreamError('not_found', 'Not found.', status);
    if (status === 400) throw new UpstreamError('bad_request', 'YouTube rejected the query.', status, googleErrorMessage(json));
    throw new UpstreamError('unavailable', 'YouTube is unavailable. Try again shortly.', status);
  }

  async myChannel(): Promise<Channel> {
    const json = (await this.get(`${DATA_API}/channels`, {
      part: 'snippet,statistics,contentDetails',
      mine: 'true',
      maxResults: '1',
    })) as { items?: Array<Record<string, any>> };
    const item = json.items?.[0];
    if (!item || typeof item.id !== 'string') throw new UpstreamError('not_found', 'This Google account has no YouTube channel.');
    return {
      channel_id: item.id,
      title: plainText(item.snippet?.title, 200),
      handle: plainText(item.snippet?.customUrl, 100),
      created_at: String(item.snippet?.publishedAt ?? ''),
      subscribers: item.statistics?.hiddenSubscriberCount ? null : num(item.statistics?.subscriberCount),
      total_views: num(item.statistics?.viewCount),
      video_count: num(item.statistics?.videoCount),
      uploads_playlist_id: String(item.contentDetails?.relatedPlaylists?.uploads ?? ''),
    };
  }

  async videos(ids: string[]): Promise<Array<Video & { channel_id: string }>> {
    if (ids.length === 0) return [];
    const json = (await this.get(`${DATA_API}/videos`, {
      part: 'snippet,statistics,contentDetails,status',
      id: ids.slice(0, 50).join(','), // the API takes up to 50 IDs and no maxResults alongside id
    })) as { items?: Array<Record<string, any>> };
    return (json.items ?? []).map((item) => {
      const seconds = durationSeconds(item.contentDetails?.duration);
      return {
        video_id: String(item.id),
        channel_id: String(item.snippet?.channelId ?? ''),
        title: plainText(item.snippet?.title, 200),
        published_at: String(item.snippet?.publishedAt ?? ''),
        duration_seconds: seconds,
        likely_short: seconds > 0 && seconds <= 180,
        views: num(item.statistics?.viewCount),
        likes: item.statistics?.likeCount === undefined ? null : num(item.statistics.likeCount),
        comments: item.statistics?.commentCount === undefined ? null : num(item.statistics.commentCount),
        privacy: String(item.status?.privacyStatus ?? ''),
      };
    });
  }

  /** Ownership check on every per-video request: a video on someone else's channel looks exactly like a missing one. */
  async ownedVideo(videoId: string, channelId: string): Promise<Video> {
    const [video] = await this.videos([videoId]);
    if (!video || video.channel_id !== channelId) throw new UpstreamError('not_found', "No video with that ID on this channel.");
    const { channel_id: _owner, ...rest } = video;
    return rest;
  }

  async recentUploads(uploadsPlaylistId: string, max: number): Promise<Video[]> {
    if (!/^UU[A-Za-z0-9_-]{22}$/.test(uploadsPlaylistId)) throw new UpstreamError('not_found', 'Uploads list not found.');
    const json = (await this.get(`${DATA_API}/playlistItems`, {
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: String(max),
    })) as { items?: Array<Record<string, any>> };
    const ids = (json.items ?? [])
      .map((item) => item.contentDetails?.videoId)
      .filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id));
    const videos = await this.videos(ids);
    return videos.map(({ channel_id: _owner, ...rest }) => rest);
  }

  /** Analytics for the owner's channel only: ids is always channel==MINE. */
  async analytics(params: {
    startDate: string;
    endDate: string;
    metrics: string[];
    dimensions?: string[];
    filters?: string;
    sort?: string;
    maxResults?: number;
  }): Promise<Report> {
    const query: Record<string, string> = {
      ids: 'channel==MINE',
      startDate: params.startDate,
      endDate: params.endDate,
      metrics: params.metrics.join(','),
    };
    if (params.dimensions?.length) query.dimensions = params.dimensions.join(',');
    if (params.filters) query.filters = params.filters;
    if (params.sort) query.sort = params.sort;
    if (params.maxResults) query.maxResults = String(params.maxResults);
    const json = (await this.get(ANALYTICS_API, query)) as {
      columnHeaders?: Array<{ name?: unknown }>;
      rows?: unknown[][];
    };
    return {
      columns: (json.columnHeaders ?? []).map((header) => String(header.name ?? '')),
      rows: (json.rows ?? []).map((row) =>
        row.map((cell) => (typeof cell === 'number' ? cell : plainText(String(cell), 100))),
      ),
    };
  }

  async comments(params: { channelId: string; videoId?: string; max: number }): Promise<Comment[]> {
    const query: Record<string, string> = {
      part: 'snippet',
      maxResults: String(params.max),
      order: 'time',
      textFormat: 'plainText',
    };
    if (params.videoId) query.videoId = params.videoId;
    else query.allThreadsRelatedToChannelId = params.channelId;
    const json = (await this.get(`${DATA_API}/commentThreads`, query)) as { items?: Array<Record<string, any>> };
    return (json.items ?? []).map((item) => {
      const top = item.snippet?.topLevelComment?.snippet ?? {};
      // Authors' names and channel IDs are left out on purpose: the analysis doesn't need them.
      return {
        published_at: String(top.publishedAt ?? ''),
        likes: num(top.likeCount),
        replies: num(item.snippet?.totalReplyCount),
        video_id: String(item.snippet?.videoId ?? top.videoId ?? ''),
        untrusted_text: plainText(top.textOriginal, 500),
      };
    });
  }
}
