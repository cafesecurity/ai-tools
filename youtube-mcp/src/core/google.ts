// This server as an OAuth client of Google: read-only scopes, PKCE, offline
// access for a refresh token, and a strict check of what Google granted.
// Endpoints are constants, never configuration. Platform-neutral.

import { callGoogle, type FetchLike, UpstreamError } from './http';
import type { GoogleIdentity } from './policy';

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';

export const YT_READ = 'https://www.googleapis.com/auth/youtube.readonly';
export const YT_ANALYTICS_READ = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const REQUESTED_SCOPES = ['openid', 'email', YT_READ, YT_ANALYTICS_READ];
/** What Google may report back. Anything outside this set means more access than we asked for. */
const ACCEPTABLE_GRANTED = new Set([
  'openid',
  'email',
  'https://www.googleapis.com/auth/userinfo.email',
  YT_READ,
  YT_ANALYTICS_READ,
]);

export interface GoogleClientSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // seconds since epoch
  scope: string;
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function newVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function googleAuthorizeUrl(settings: GoogleClientSettings, state: string, codeChallenge: string): string {
  const url = new URL(GOOGLE_AUTHORIZE);
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('redirect_uri', settings.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', REQUESTED_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline'); // a refresh token, so the owner signs in rarely
  url.searchParams.set('prompt', 'consent select_account'); // always show Google's consent and account picker
  url.searchParams.set('include_granted_scopes', 'false'); // never inherit broader scopes granted earlier
  return url.toString();
}

/** Both read-only YouTube scopes granted, and nothing beyond what we asked for. */
export function checkGrantedScopes(scope: string): string | null {
  const granted = scope.split(/\s+/).filter(Boolean);
  for (const needed of [YT_READ, YT_ANALYTICS_READ]) {
    if (!granted.includes(needed)) return 'Both YouTube permissions are needed. Sign in again and tick both boxes.';
  }
  if (granted.some((item) => !ACCEPTABLE_GRANTED.has(item))) return 'Google granted more access than this server asks for, so the sign-in was refused.';
  return null;
}

function parseTokens(json: unknown, now: number): GoogleTokens {
  const body = json as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown } | null;
  if (!body || typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new UpstreamError('unavailable', 'Google returned an unexpected response.');
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: now + Math.max(0, Math.floor(body.expires_in)),
    scope: typeof body.scope === 'string' ? body.scope : '',
  };
}

function tokenError(status: number, json: unknown): UpstreamError {
  const code = (json as { error?: unknown } | null)?.error;
  if (code === 'invalid_grant') return new UpstreamError('auth', 'Google access was revoked or has expired.', status);
  if (status >= 500 || status === 429) return new UpstreamError('unavailable', 'Google is unavailable. Try again shortly.', status);
  return new UpstreamError('bad_request', 'Google refused the sign-in.', status);
}

export async function exchangeCode(
  fetchImpl: FetchLike,
  settings: GoogleClientSettings,
  code: string,
  verifier: string,
  now = Math.floor(Date.now() / 1000),
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: settings.redirectUri,
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
  });
  const { status, json } = await callGoogle(fetchImpl, new URL(GOOGLE_TOKEN), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (status !== 200) throw tokenError(status, json);
  return parseTokens(json, now);
}

export async function refreshGoogleToken(
  fetchImpl: FetchLike,
  settings: GoogleClientSettings,
  refreshToken: string,
  now = Math.floor(Date.now() / 1000),
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
  });
  const { status, json } = await callGoogle(fetchImpl, new URL(GOOGLE_TOKEN), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (status !== 200) throw tokenError(status, json);
  return parseTokens(json, now);
}

/** Who signed in, asked of Google over TLS with the fresh access token (no ID-token parsing needed). */
export async function fetchIdentity(fetchImpl: FetchLike, accessToken: string): Promise<GoogleIdentity> {
  const { status, json } = await callGoogle(fetchImpl, new URL(GOOGLE_USERINFO), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = json as { sub?: unknown; email?: unknown; email_verified?: unknown } | null;
  if (status !== 200 || !body || typeof body.sub !== 'string') {
    throw new UpstreamError('unavailable', 'Google did not say who signed in.', status);
  }
  return {
    sub: body.sub,
    email: typeof body.email === 'string' ? body.email : undefined,
    emailVerified: body.email_verified === true,
  };
}

/** Best effort: revoke a Google token we won't keep (for example, a refused account's). */
export async function revokeGoogleToken(fetchImpl: FetchLike, token: string): Promise<void> {
  try {
    await callGoogle(fetchImpl, new URL(GOOGLE_REVOKE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Nothing more to do: the token is discarded either way.
  }
}
