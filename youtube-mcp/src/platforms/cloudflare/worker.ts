// Cloudflare Workers adapter. Everything platform-specific lives here: the
// OAuth provider library (KV-backed, tokens stored as hashes, props encrypted),
// the routes, and the optional platform rate limiter. The security decisions
// themselves are in src/core and are the same on any platform (docs/PORTING.md).

import {
  AuthorizationError,
  CimdFetchError,
  OAuthError,
  OAuthProvider,
  authorizationErrorRedirect,
  insufficientScope,
  type AuthRequest,
  type OAuthHelpers,
  type OAuthProviderOptions,
  type OAuthResourceContext,
  type TokenExchangeCallbackOptions,
} from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { type Config, type RawSettings, parseConfig } from '../../core/config';
import {
  type GoogleClientSettings,
  checkGrantedScopes,
  exchangeCode,
  fetchIdentity,
  googleAuthorizeUrl,
  newVerifier,
  refreshGoogleToken,
  revokeGoogleToken,
  s256,
} from '../../core/google';
import { consentPage, htmlResponse, messagePage, pageCsp } from '../../core/html';
import { UpstreamError } from '../../core/http';
import { logEvent } from '../../core/log';
import { formActionSources, isAllowedAccount, isAllowedChannel, isAllowedOrigin, isAllowedRedirectUri } from '../../core/policy';
import { MemoryRateLimiter, type RateLimiter } from '../../core/ratelimit';
import { SERVER_NAME, buildServer } from '../../core/tools';
import { YouTubeClient } from '../../core/youtube';

/** The one scope this server grants. It means "read the owner's YouTube data", nothing more. */
const SCOPE = 'youtube:read';
const MAX_BODY_BYTES = 64 * 1024;
const PLAIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

interface PlatformRateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env extends RawSettings {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Optional Workers rate-limiting binding; preferred over the in-memory limiter when bound. */
  RATE_LIMITER?: PlatformRateLimit;
}

/** Stored, encrypted, with the grant. Holds the only long-lived Google credential. */
interface GrantProps {
  sub: string;
  email?: string;
  channelId: string;
  googleRefreshToken: string;
  /** Present only between sign-in and the first token exchange. */
  googleAccessToken?: string;
  googleAccessTokenExpiresAt?: number;
}

/** Stored, encrypted, with each MCP access token. Never holds the refresh token. */
interface AccessProps {
  sub: string;
  email?: string;
  channelId: string;
  googleAccessToken: string;
  googleAccessTokenExpiresAt: number;
}

interface UpstreamData {
  verifier: string;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function readConfig(env: Env): Config | null {
  const result = parseConfig(env);
  if (result.ok) return result.config;
  // Problems name settings, never their values.
  logEvent('config_invalid', { problems: result.problems.length });
  return null;
}

function googleSettings(config: Config): GoogleClientSettings {
  return { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri };
}

function notConfigured(): Response {
  return htmlResponse(
    messagePage('Not set up yet', 'This server is missing required settings. The owner should check the deployment logs and the README.'),
    503,
    PLAIN_CSP,
  );
}

function refusal(title: string, message: string, status = 400, headers?: Headers): Response {
  return htmlResponse(messagePage(title, message), status, PLAIN_CSP, headers);
}

function redirect(location: string, headers?: Headers): Response {
  const out = new Headers(headers);
  out.set('Location', location);
  out.set('Cache-Control', 'no-store');
  out.set('Referrer-Policy', 'no-referrer');
  return new Response(null, { status: 302, headers: out });
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded')) return null;
  const length = Number(request.headers.get('Content-Length') ?? '0');
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  return new URLSearchParams(text);
}

/** The redirect-URI allowlist, checked before anything is shown or any redirect is sent. */
function checkAuthRequest(config: Config, authRequest: AuthRequest): string | null {
  if (!isAllowedRedirectUri(config, authRequest.redirectUri)) return 'redirect_not_allowed';
  if (!authRequest.codeChallenge) return 'pkce_missing'; // S256 itself is enforced by the library
  return null;
}

// ---------------------------------------------------------------------------
// Browser-facing routes: /authorize (consent), /callback (from Google)
// ---------------------------------------------------------------------------

async function handleAuthorizeGet(request: Request, env: Env, config: Config): Promise<Response> {
  const helpers = env.OAUTH_PROVIDER;
  const authRequest = await helpers.parseAuthRequest(request);
  const problem = checkAuthRequest(config, authRequest);
  if (problem) {
    logEvent('authorize_refused', { reason: problem });
    // Rendered here, never redirected: an unapproved redirect URI must not receive anything.
    return refusal('This app is not approved', 'The owner of this server has not approved this app. They can add it in the server settings.', 403);
  }
  const description = await helpers.describeConsent(authRequest);
  const { handle, headers } = await helpers.beginConsent(authRequest);
  return htmlResponse(
    consentPage({
      clientName: description.clientName,
      clientDomain: description.clientDomain,
      redirectHost: description.redirectHost,
      redirectIsLoopback: description.redirectIsLoopback,
      handle,
    }),
    200,
    pageCsp(formActionSources(config)),
    headers,
  );
}

async function handleAuthorizePost(request: Request, env: Env, config: Config): Promise<Response> {
  const helpers = env.OAUTH_PROVIDER;
  const form = await readForm(request);
  const handle = form?.get('handle') ?? '';
  const decision = form?.get('decision');

  if (decision !== 'approve') {
    const denied = await helpers.denyConsent(request, handle);
    logEvent('consent_denied');
    if (!isAllowedRedirectUri(config, denied.request.redirectUri)) {
      return refusal('Cancelled', 'Nothing was shared.', 200, denied.headers);
    }
    return redirect(denied.redirectTo, denied.headers);
  }

  // The library checks the handle is bound to this browser and single-use.
  const approved = await helpers.approveConsent(request, handle, { scope: [SCOPE] });
  const problem = checkAuthRequest(config, approved.request);
  if (problem) {
    logEvent('authorize_refused', { reason: problem });
    return refusal('This app is not approved', 'The owner of this server has not approved this app.', 403, approved.headers);
  }
  const verifier = newVerifier();
  const upstream = await helpers.beginUpstream(approved.request, {
    data: { verifier } satisfies UpstreamData,
    headers: approved.headers,
  });
  return redirect(googleAuthorizeUrl(googleSettings(config), upstream.state, await s256(verifier)), upstream.headers);
}

async function handleCallback(request: Request, env: Env, config: Config): Promise<Response> {
  const helpers = env.OAUTH_PROVIDER;
  const resumed = await helpers.finishUpstream<UpstreamData>(request); // checks state, browser binding, single use
  const original = resumed.request;
  const canRedirect = isAllowedRedirectUri(config, original.redirectUri);
  const params = new URL(request.url).searchParams;

  const fail = (reason: string, title: string, message: string, oauthCode: 'access_denied' | 'server_error' = 'access_denied') => {
    logEvent('signin_refused', { reason });
    if (canRedirect && reason === 'google_cancelled') {
      return redirect(authorizationErrorRedirect(original, oauthCode), resumed.headers);
    }
    return refusal(title, message, 403, resumed.headers);
  };

  if (params.get('error')) return fail('google_cancelled', 'Sign-in cancelled', 'Nothing was shared.');
  const code = params.get('code');
  if (!code || !resumed.data?.verifier) return fail('no_code', 'Sign-in failed', 'Google did not complete the sign-in. Try again.');

  const settings = googleSettings(config);
  let tokens;
  try {
    tokens = await exchangeCode(fetch, settings, code, resumed.data.verifier);
  } catch {
    return fail('code_exchange', 'Sign-in failed', 'Google did not complete the sign-in. Try again.');
  }
  // From here on, any refusal also revokes what Google just issued.
  const refuse = async (reason: string, title: string, message: string) => {
    await revokeGoogleToken(fetch, tokens.refreshToken ?? tokens.accessToken);
    return fail(reason, title, message);
  };

  const scopeProblem = checkGrantedScopes(tokens.scope);
  if (scopeProblem) return refuse('scopes', 'Permissions not granted', scopeProblem);
  if (!tokens.refreshToken) {
    return refuse('no_refresh_token', 'Sign-in failed', 'Google did not issue a long-lived sign-in. Remove this app from your Google account permissions and try again.');
  }

  let identity;
  try {
    identity = await fetchIdentity(fetch, tokens.accessToken);
  } catch {
    return refuse('identity', 'Sign-in failed', 'Google did not say who signed in. Try again.');
  }
  if (!isAllowedAccount(config, identity)) {
    return refuse('account_not_allowed', 'Account not allowed', 'This Google account is not on this server’s allowlist.');
  }

  let channelId: string;
  try {
    channelId = (await new YouTubeClient(tokens.accessToken, fetch).myChannel()).channel_id;
  } catch {
    return refuse('no_channel', 'No channel found', 'This Google account has no YouTube channel, or YouTube is unavailable.');
  }
  if (!isAllowedChannel(config, channelId)) {
    return refuse('channel_not_allowed', 'Channel not allowed', 'This channel is not on this server’s allowlist.');
  }

  const props: GrantProps = {
    sub: identity.sub,
    email: identity.email,
    channelId,
    googleRefreshToken: tokens.refreshToken,
    googleAccessToken: tokens.accessToken,
    googleAccessTokenExpiresAt: tokens.expiresAt,
  };
  const { redirectTo } = await helpers.completeAuthorization({
    request: original,
    userId: identity.sub,
    metadata: {}, // stored unencrypted, so deliberately empty
    scope: [SCOPE],
    props,
  });
  logEvent('signin_completed');
  return redirect(redirectTo, resumed.headers);
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = readConfig(env);
    if (!config) return notConfigured();
    const url = new URL(request.url);
    try {
      if (url.pathname === '/authorize' && request.method === 'GET') return await handleAuthorizeGet(request, env, config);
      if (url.pathname === '/authorize' && request.method === 'POST') return await handleAuthorizePost(request, env, config);
      if (url.pathname === '/callback' && request.method === 'GET') return await handleCallback(request, env, config);
      if (url.pathname === '/' && request.method === 'GET') {
        return refusal(SERVER_NAME, 'A read-only MCP server for YouTube analytics. Connect to it from an MCP client at /mcp.', 200);
      }
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    } catch (error) {
      if (error instanceof AuthorizationError) {
        // Shown here, never redirected: the redirect URI may be one the owner hasn't approved.
        logEvent('authorize_refused', { reason: error.code });
        return refusal('Request not valid', 'This sign-in link is invalid, expired or already used. Start again from your app.');
      }
      if (error instanceof CimdFetchError) {
        logEvent('authorize_refused', { reason: error.reason });
        return refusal('App not recognised', 'This app’s details could not be fetched.');
      }
      logEvent('authorize_refused', { reason: 'internal' });
      return refusal('Something went wrong', 'Try again from your app.', 500);
    }
  },
};

// ---------------------------------------------------------------------------
// The MCP endpoint
// ---------------------------------------------------------------------------

const memoryLimiters = new Map<number, MemoryRateLimiter>();

function limiterFor(env: Env, config: Config): RateLimiter {
  if (env.RATE_LIMITER) {
    const binding = env.RATE_LIMITER;
    return { allow: async (key) => (await binding.limit({ key })).success };
  }
  let limiter = memoryLimiters.get(config.rateLimitPerMinute);
  if (!limiter) {
    limiter = new MemoryRateLimiter(config.rateLimitPerMinute);
    memoryLimiters.set(config.rateLimitPerMinute, limiter);
  }
  return limiter;
}

function jsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

// One handler for the isolate; each request gets a fresh McpServer built for its caller.
const mcp = createMcpHandler(
  (ctx) => {
    const extra = (ctx.authInfo?.extra ?? {}) as { channelId?: string; googleAccessToken?: string; enableComments?: boolean };
    if (!extra.channelId || !extra.googleAccessToken) throw new Error('missing auth context');
    return buildServer({
      client: new YouTubeClient(extra.googleAccessToken, fetch),
      channelId: extra.channelId,
      includeComments: extra.enableComments === true,
    });
  },
  {
    legacy: 'stateless',
    responseMode: 'json',
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: () => logEvent('tool_error', { kind: 'transport' }),
  },
);

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: OAuthResourceContext<AccessProps>): Promise<Response> {
    const config = readConfig(env);
    if (!config) return jsonError(503, 'Server not configured');

    // Browsers are refused unless their origin is listed (DNS rebinding, cross-site calls).
    if (!isAllowedOrigin(config, request.headers.get('Origin'))) {
      logEvent('mcp_refused', { reason: 'origin' });
      return jsonError(403, 'Origin not allowed');
    }
    // The library has checked the token and its audience; the scope is ours to check.
    if (!ctx.auth.scope.includes(SCOPE)) return insufficientScope(ctx.auth, [SCOPE]);

    const props = ctx.props;
    // Re-check the allowlists on every call, so removing an account or channel takes effect at once.
    if (
      !props ||
      !isAllowedAccount(config, { sub: props.sub, email: props.email, emailVerified: true }) ||
      !isAllowedChannel(config, props.channelId)
    ) {
      logEvent('mcp_refused', { reason: 'not_allowed' });
      return jsonError(403, 'Access not allowed');
    }
    if (!props.googleAccessToken || props.googleAccessTokenExpiresAt <= nowSeconds() + 30) {
      return jsonError(401, 'Token expired', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    }
    if (!(await limiterFor(env, config).allow(props.sub))) {
      logEvent('rate_limited');
      return jsonError(429, 'Too many requests. Try again in a minute.', { 'Retry-After': '60' });
    }

    return mcp.fetch(request, {
      authInfo: {
        token: ctx.auth.token,
        clientId: ctx.auth.clientId ?? '',
        scopes: ctx.auth.scope,
        expiresAt: ctx.auth.expiresAt,
        resource: new URL(ctx.auth.audience),
        // Server-side only: the factory reads these; nothing here is sent to the client.
        extra: { channelId: props.channelId, googleAccessToken: props.googleAccessToken, enableComments: config.enableComments },
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Token issuance: swap Google tokens in and out of the props
// ---------------------------------------------------------------------------

function accessTokenTtl(googleExpiresAt: number): number {
  return Math.max(60, Math.min(3600, googleExpiresAt - nowSeconds() - 60));
}

async function tokenExchangeCallback(options: TokenExchangeCallbackOptions<Env>) {
  const config = readConfig(options.env);
  if (!config) throw new OAuthError('temporarily_unavailable', { description: 'Server not configured' });
  const props = options.props as GrantProps;

  // The owner may have been removed from the allowlist since signing in.
  if (!isAllowedAccount(config, { sub: props.sub, email: props.email, emailVerified: true }) || !isAllowedChannel(config, props.channelId)) {
    await revokeGoogleToken(fetch, props.googleRefreshToken);
    throw new OAuthError('invalid_grant', { description: 'Access is no longer allowed' });
  }

  const base = { sub: props.sub, email: props.email, channelId: props.channelId };
  const grantOnly: GrantProps = { ...base, googleRefreshToken: props.googleRefreshToken };

  if (options.grantType === 'authorization_code' && props.googleAccessToken && props.googleAccessTokenExpiresAt) {
    // First exchange: use the Google access token from sign-in, then drop it from the grant.
    const accessTokenProps: AccessProps = {
      ...base,
      googleAccessToken: props.googleAccessToken,
      googleAccessTokenExpiresAt: props.googleAccessTokenExpiresAt,
    };
    return { accessTokenProps, newProps: grantOnly, accessTokenTTL: accessTokenTtl(props.googleAccessTokenExpiresAt) };
  }

  if (options.grantType === 'refresh_token' || options.grantType === 'authorization_code') {
    let tokens;
    try {
      tokens = await refreshGoogleToken(fetch, googleSettings(config), props.googleRefreshToken);
    } catch (error) {
      const kind = error instanceof UpstreamError ? error.kind : 'internal';
      logEvent('google_refresh_failed', { kind });
      if (kind === 'auth') throw new OAuthError('invalid_grant', { description: 'Google access was revoked or has expired' });
      throw new OAuthError('temporarily_unavailable', { description: 'Google is unavailable' });
    }
    const accessTokenProps: AccessProps = { ...base, googleAccessToken: tokens.accessToken, googleAccessTokenExpiresAt: tokens.expiresAt };
    const newProps: GrantProps = { ...grantOnly, googleRefreshToken: tokens.refreshToken ?? props.googleRefreshToken };
    return { accessTokenProps, newProps, accessTokenTTL: accessTokenTtl(tokens.expiresAt) };
  }

  // Token exchange and other grants are switched off; refuse anything unexpected.
  throw new OAuthError('unsupported_grant_type', { description: 'Not supported' });
}

// ---------------------------------------------------------------------------
// The provider, built once per isolate for the configured public URL
// ---------------------------------------------------------------------------

function providerOptions(config: Config): OAuthProviderOptions<Env> {
  return {
    apiRoute: '/mcp',
    apiHandler: apiHandler as unknown as OAuthProviderOptions<Env>['apiHandler'],
    defaultHandler: defaultHandler as unknown as OAuthProviderOptions<Env>['defaultHandler'],
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPE, 'offline_access'],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource: config.resource, resource_name: 'YouTube analytics (read-only)' },
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    clientRegistrationTTL: 30 * 24 * 3600,
    allowTokenExchangeGrant: false,
    // Registration is open by protocol, but only for clients whose every redirect URI the owner approved.
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = clientMetadata.redirect_uris;
      const ok = Array.isArray(uris) && uris.length > 0 && uris.length <= 10 && uris.every((uri) => typeof uri === 'string' && isAllowedRedirectUri(config, uri));
      if (ok) return;
      logEvent('client_registration_refused');
      return { code: 'invalid_redirect_uri', description: 'This server only accepts apps its owner has approved.', status: 400 };
    },
    tokenExchangeCallback,
    onError: ({ code, internal }) => {
      logEvent('oauth_error', { code, reason: typeof internal === 'string' ? internal : String((internal as { reason?: unknown })?.reason ?? '') });
    },
  };
}

let cached: { key: string; provider: OAuthProvider<Env> } | null = null;

async function limitRegistration(request: Request, env: Env, config: Config): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/register') return null;
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (await limiterFor(env, config).allow(`register:${ip}`)) return null;
  logEvent('rate_limited', { route: 'register' });
  return jsonError(429, 'Too many requests', { 'Retry-After': '60' });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = readConfig(env);
    if (!config) {
      return new URL(request.url).pathname.startsWith('/mcp') ? jsonError(503, 'Server not configured') : notConfigured();
    }
    // Requests must arrive at the configured public URL, so metadata and token audiences agree.
    if (new URL(request.url).origin !== config.publicUrl) return jsonError(421, 'Wrong host');
    const limited = await limitRegistration(request, env, config);
    if (limited) return limited;

    const key = JSON.stringify([config.publicUrl, config.allowedRedirectUris, config.allowLoopbackRedirects]);
    if (!cached || cached.key !== key) cached = { key, provider: new OAuthProvider<Env>(providerOptions(config)) };
    return cached.provider.fetch(request, env, ctx);
  },
};
