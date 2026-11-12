// Configuration, read from plain string settings (environment variables or the
// platform's equivalent). Everything fails closed: a missing or malformed
// setting means "not configured", and the server refuses to sign anyone in.
//
// Platform-neutral: no runtime-specific APIs.

export interface RawSettings {
  PUBLIC_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOWED_GOOGLE_ACCOUNTS?: string;
  ALLOWED_CHANNEL_IDS?: string;
  ALLOWED_REDIRECT_URIS?: string;
  ALLOW_LOOPBACK_REDIRECTS?: string;
  ALLOWED_ORIGINS?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  ENABLE_COMMENTS?: string;
}

export type AllowedAccount = { kind: 'sub'; value: string } | { kind: 'email'; value: string };

export interface Config {
  /** Origin this server is reached at, e.g. https://yt-mcp.example.com (no trailing slash, no path). */
  publicUrl: string;
  /** The MCP endpoint, which is also the OAuth protected resource identifier. */
  resource: string;
  /** Where Google sends the owner back after signing in. */
  googleRedirectUri: string;
  googleClientId: string;
  googleClientSecret: string;
  allowedAccounts: AllowedAccount[];
  /** Optional: only these channel IDs may be read. Empty means "the signed-in owner's channel". */
  allowedChannelIds: string[];
  /** Exact redirect URIs of approved MCP clients. */
  allowedRedirectUris: string[];
  /** Allow local apps (http://localhost, 127.0.0.1, [::1]) as MCP clients. Off by default. */
  allowLoopbackRedirects: boolean;
  /** Browser origins allowed to call the MCP endpoint. Empty means none (server-to-server only). */
  allowedOrigins: string[];
  rateLimitPerMinute: number;
  /** Offer the comments tool. Off by default: comments are text written by strangers (untrusted input). */
  enableComments: boolean;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const GOOGLE_SUB = /^[0-9]{5,40}$/;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** An https URL, or http on a loopback host (local development only). */
function parseOrigin(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  return null;
}

function parseRedirectUri(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol !== 'https:') return null; // loopback clients are handled by ALLOW_LOOPBACK_REDIRECTS
  return url.toString();
}

export function parseConfig(raw: RawSettings): ConfigResult {
  const problems: string[] = [];

  const origin = raw.PUBLIC_URL ? parseOrigin(raw.PUBLIC_URL.trim()) : null;
  if (!origin) problems.push('PUBLIC_URL must be the https origin this server is reached at, with no path');

  const googleClientId = (raw.GOOGLE_CLIENT_ID ?? '').trim();
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(googleClientId)) {
    problems.push('GOOGLE_CLIENT_ID must be a Google OAuth client ID (…apps.googleusercontent.com)');
  }
  const googleClientSecret = (raw.GOOGLE_CLIENT_SECRET ?? '').trim();
  if (googleClientSecret.length < 10) problems.push('GOOGLE_CLIENT_SECRET is missing (set it as a secret, never in a file)');

  const allowedAccounts: AllowedAccount[] = [];
  for (const item of list(raw.ALLOWED_GOOGLE_ACCOUNTS)) {
    if (item.startsWith('sub:') && GOOGLE_SUB.test(item.slice(4))) allowedAccounts.push({ kind: 'sub', value: item.slice(4) });
    else if (EMAIL.test(item)) allowedAccounts.push({ kind: 'email', value: item.toLowerCase() });
    else problems.push('ALLOWED_GOOGLE_ACCOUNTS has an entry that is neither an email address nor sub:<Google subject ID>');
  }
  if (allowedAccounts.length === 0) problems.push('ALLOWED_GOOGLE_ACCOUNTS is empty, so nobody could sign in');

  const allowedChannelIds = list(raw.ALLOWED_CHANNEL_IDS);
  if (allowedChannelIds.some((id) => !CHANNEL_ID.test(id))) problems.push('ALLOWED_CHANNEL_IDS has an entry that is not a channel ID (UC…)');

  const allowLoopbackRedirects = (raw.ALLOW_LOOPBACK_REDIRECTS ?? '').trim().toLowerCase() === 'true';
  const allowedRedirectUris: string[] = [];
  for (const item of list(raw.ALLOWED_REDIRECT_URIS)) {
    const parsed = parseRedirectUri(item);
    if (parsed) allowedRedirectUris.push(parsed);
    else problems.push('ALLOWED_REDIRECT_URIS has an entry that is not an https URL');
  }
  if (allowedRedirectUris.length === 0 && !allowLoopbackRedirects) {
    problems.push('ALLOWED_REDIRECT_URIS is empty, so no MCP client could connect');
  }

  const allowedOrigins: string[] = [];
  for (const item of list(raw.ALLOWED_ORIGINS)) {
    const parsed = parseOrigin(item);
    if (parsed) allowedOrigins.push(parsed.origin);
    else problems.push('ALLOWED_ORIGINS has an entry that is not an origin (scheme and host only)');
  }

  const rate = raw.RATE_LIMIT_PER_MINUTE ? Number(raw.RATE_LIMIT_PER_MINUTE) : 30;
  if (!Number.isInteger(rate) || rate < 1 || rate > 600) problems.push('RATE_LIMIT_PER_MINUTE must be a whole number from 1 to 600');

  if (problems.length > 0 || !origin) return { ok: false, problems };

  const publicUrl = origin.origin;
  return {
    ok: true,
    config: {
      publicUrl,
      resource: `${publicUrl}/mcp`,
      googleRedirectUri: `${publicUrl}/callback`,
      googleClientId,
      googleClientSecret,
      allowedAccounts,
      allowedChannelIds,
      allowedRedirectUris,
      allowLoopbackRedirects,
      allowedOrigins,
      rateLimitPerMinute: rate,
      enableComments: (raw.ENABLE_COMMENTS ?? '').trim().toLowerCase() === 'true',
    },
  };
}
