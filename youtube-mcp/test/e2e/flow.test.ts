// End to end: the bundled Worker in workerd (via Miniflare), with Google faked
// at the network boundary. Runs the full sign-in, token and MCP flow, plus the
// refusals that matter. Build first: npm run build:e2e
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_CHANNEL, youtubeFixture } from '../helpers';

const ORIGIN = 'https://yt.example.com';
const CLIENT_REDIRECT = 'https://client.example.com/callback';
const YT_SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly';

const BINDINGS = {
  PUBLIC_URL: ORIGIN,
  GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-secret-not-real',
  ALLOWED_GOOGLE_ACCOUNTS: 'owner@example.com sub:3333333333',
  ALLOWED_REDIRECT_URIS: CLIENT_REDIRECT,
  ALLOW_LOOPBACK_REDIRECTS: 'false',
  ALLOWED_ORIGINS: '',
  RATE_LIMIT_PER_MINUTE: '30',
  ENABLE_COMMENTS: 'false',
};

const revoked: string[] = [];
const googleCalls: string[] = [];

async function fakeGoogle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  googleCalls.push(url.hostname + url.pathname);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
    const form = new URLSearchParams(await request.text());
    if (form.get('client_secret') !== BINDINGS.GOOGLE_CLIENT_SECRET) return json({ error: 'invalid_client' }, 401);
    if (form.get('grant_type') === 'authorization_code') {
      if (!form.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
      const code = form.get('code');
      const who = code === 'owner-code' ? 'owner' : code === 'unverified-code' ? 'unverified' : 'stranger';
      return json({ access_token: `ya29.${who}`, refresh_token: `1//rt-${who}`, expires_in: 3599, scope: YT_SCOPES, token_type: 'Bearer' });
    }
    if (form.get('grant_type') === 'refresh_token') {
      return json({ access_token: 'ya29.owner-refreshed', expires_in: 3599, scope: YT_SCOPES, token_type: 'Bearer' });
    }
  }
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
    revoked.push(new URLSearchParams(await request.text()).get('token') ?? '');
    return json({});
  }
  if (url.hostname === 'openidconnect.googleapis.com') {
    const auth = request.headers.get('Authorization') ?? '';
    if (auth.startsWith('Bearer ya29.owner')) return json({ sub: '1111111111', email: 'owner@example.com', email_verified: true });
    // Listed by subject ID, and showing the owner's email address without Google having verified it.
    if (auth.startsWith('Bearer ya29.unverified')) return json({ sub: '3333333333', email: 'owner@example.com', email_verified: false });
    return json({ sub: '2222222222', email: 'stranger@example.com', email_verified: true });
  }
  if (url.hostname.endsWith('googleapis.com')) {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ya29.')) return json({ error: {} }, 401);
    const { status = 200, body } = youtubeFixture(url);
    return json(body, status);
  }
  return new Response('blocked by test', { status: 599 });
}

let mf: Miniflare;

function options(bindings: Record<string, string>) {
  return convertV4MiniflareOptions({
    workers: [
      {
        name: 'youtube-mcp',
        modules: true,
        scriptPath: '.wrangler/e2e/worker.js',
        compatibilityDate: '2026-11-01',
        compatibilityFlags: ['global_fetch_strictly_public'],
        kvNamespaces: ['OAUTH_KV'],
        bindings,
        outboundService: fakeGoogle,
      },
    ],
  } as never);
}
let ipCounter = 0;
/** Each call comes from a fresh IP unless one is given, so the per-IP limit only bites where a test wants it to. */
const call = (path: string, init?: RequestInit, ip = `198.51.100.${++ipCounter % 250}`) => {
  const headers = new Headers(init?.headers);
  headers.set('CF-Connecting-IP', ip);
  return mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init, headers } as never) as unknown as Promise<Response>;
};

beforeAll(async () => {
  mf = new Miniflare(options(BINDINGS));
  await mf.ready;
});
afterAll(async () => mf?.dispose());

async function s256(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString('base64url');
}

class Jar {
  private cookies = new Map<string, string>();
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [name, ...rest] = pair!.split('=');
      this.cookies.set(name!.trim(), rest.join('='));
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function register(redirectUris: string[]) {
  return call('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test client', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' }),
  });
}

function authorizeUrl(clientId: string, challenge: string | null, redirectUri = CLIENT_REDIRECT) {
  const url = new URL(`${ORIGIN}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', 'client-state');
  url.searchParams.set('scope', 'youtube:read');
  url.searchParams.set('resource', `${ORIGIN}/mcp`);
  if (challenge) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.pathname + url.search;
}

/** Walks consent → Google → callback. Returns the final response from /callback. */
async function signIn(clientId: string, verifier: string, googleCode: string) {
  const jar = new Jar();
  const consent = await call(authorizeUrl(clientId, await s256(verifier)));
  expect(consent.status).toBe(200);
  jar.take(consent);
  const html = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const approve = await call('/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    body: new URLSearchParams({ handle, decision: 'approve' }).toString(),
  });
  expect(approve.status).toBe(302);
  jar.take(approve);
  const google = new URL(approve.headers.get('Location')!);
  expect(google.origin).toBe('https://accounts.google.com');
  const state = google.searchParams.get('state')!;
  return call(`/callback?state=${encodeURIComponent(state)}&code=${googleCode}`, { headers: { Cookie: jar.header() } });
}

describe('end to end', () => {
  let clientId = '';
  let accessToken = '';
  let refreshToken = '';

  it('publishes protected resource metadata for /mcp', async () => {
    const response = await call('/.well-known/oauth-protected-resource/mcp');
    const body = (await response.json()) as { resource: string; authorization_servers: string[]; scopes_supported?: string[] };
    expect(body.resource).toBe(`${ORIGIN}/mcp`);
    expect(body.authorization_servers).toContain(ORIGIN);
    const as = (await (await call('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.grant_types_supported).not.toContain('urn:ietf:params:oauth:grant-type:token-exchange');
  });

  it('answers /mcp without a token with a 401 pointing at the metadata', async () => {
    const response = await call('/mcp', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
  });

  it('refuses requests for a different host', async () => {
    const response = (await mf.dispatchFetch('https://evil.example.net/mcp', { method: 'POST' })) as unknown as Response;
    expect(response.status).toBe(421);
  });

  it('refuses to register a client with an unapproved redirect URI', async () => {
    const response = await register(['https://evil.test/callback']);
    expect(response.status).toBe(400);
    const mixed = await register([CLIENT_REDIRECT, 'https://evil.test/callback']);
    expect(mixed.status).toBe(400);
  });

  it('registers an approved client', async () => {
    const response = await register([CLIENT_REDIRECT]);
    expect(response.status).toBe(201);
    clientId = ((await response.json()) as { client_id: string }).client_id;
    expect(clientId).toBeTruthy();
  });

  it('refuses to authorize without PKCE, and never redirects', async () => {
    const response = await call(authorizeUrl(clientId, null));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('Location')).toBeNull();
  });

  it('refuses plain PKCE', async () => {
    const url = authorizeUrl(clientId, 'x'.repeat(43)).replace('code_challenge_method=S256', 'code_challenge_method=plain');
    const response = await call(url);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('Location')).toBeNull();
  });

  it('serves the consent page with a strict CSP and no framing', async () => {
    const response = await call(authorizeUrl(clientId, await s256('v'.repeat(43))));
    expect(response.status).toBe(200);
    const csp = response.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('form-action');
    expect(csp).not.toContain('evil');
  });

  it('refuses a POST to /authorize without the browser binding cookie', async () => {
    const consent = await call(authorizeUrl(clientId, await s256('w'.repeat(43))));
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1]!;
    const response = await call('/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handle, decision: 'approve' }).toString(),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
  });

  it('refuses a Google account that is not on the allowlist, and revokes its token', async () => {
    const response = await signIn(clientId, 's'.repeat(43), 'stranger-code');
    expect(response.status).toBe(403);
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).toContain('Account not allowed');
    expect(revoked).toContain('1//rt-stranger');
  });

  it('signs the owner in and returns a code to the approved client with iss', async () => {
    const verifier = 'o'.repeat(43);
    const response = await signIn(clientId, verifier, 'owner-code');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
    const code = location.searchParams.get('code')!;

    const wrongVerifier = await call('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CLIENT_REDIRECT, code_verifier: 'x'.repeat(43), resource: `${ORIGIN}/mcp` }).toString(),
    });
    expect(wrongVerifier.status).toBe(400);
  });

  it('issues tokens for the right code and verifier, without Google tokens in the response', async () => {
    const verifier = 'p'.repeat(43);
    const response = await signIn(clientId, verifier, 'owner-code');
    const code = new URL(response.headers.get('Location')!).searchParams.get('code')!;
    const token = await call('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CLIENT_REDIRECT, code_verifier: verifier, resource: `${ORIGIN}/mcp` }).toString(),
    });
    expect(token.status).toBe(200);
    const text = await token.text();
    expect(text).not.toContain('ya29');
    expect(text).not.toContain('1//rt');
    const body = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    expect(body.expires_in).toBeLessThanOrEqual(3600);
    accessToken = body.access_token;
    refreshToken = body.refresh_token;
    expect(refreshToken).toBeTruthy();
  });

  let unverifiedToken = '';
  it('signs in an account listed by subject ID, without storing its unverified email', async () => {
    const verifier = 'u'.repeat(43);
    const response = await signIn(clientId, verifier, 'unverified-code');
    expect(response.status).toBe(302);
    const code = new URL(response.headers.get('Location')!).searchParams.get('code')!;
    const token = await call('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CLIENT_REDIRECT, code_verifier: verifier, resource: `${ORIGIN}/mcp` }).toString(),
    });
    expect(token.status).toBe(200);
    unverifiedToken = ((await token.json()) as { access_token: string }).access_token;
  });

  it('refuses JSON-RPC batches', async () => {
    const one = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const response = await call('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify([one, { ...one, id: 2 }]),
    });
    expect(response.status).toBe(400);
  });

  it('limits anonymous routes per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call('/authorize?client_id=x', undefined, '203.0.113.9')).status);
    expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('serves read-only tools over MCP with the token', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (input, init) => mf.dispatchFetch(String(input), init as never) as unknown as Promise<Response>,
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('get_recent_comments');
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const overview = await client.callTool({ name: 'get_channel_overview', arguments: {} });
    const body = JSON.parse((overview.content as Array<{ text: string }>)[0]!.text);
    expect(body.channel_id).toBe(OWNER_CHANNEL);
    await client.close();
  });

  it('refuses browser calls from unlisted origins', async () => {
    const response = await call('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Origin: 'https://evil.test', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('refuses a made-up token', async () => {
    const response = await call('/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-real-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('refreshes through Google, and stops at once when the owner is removed from the allowlist', async () => {
    const refresh = (token: string) =>
      call('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }).toString(),
      });
    const first = await refresh(refreshToken);
    expect(first.status).toBe(200);
    const next = (await first.json()) as { access_token: string; refresh_token: string };
    expect(googleCalls.filter((c) => c === 'oauth2.googleapis.com/token').length).toBeGreaterThan(2);

    // Remove the subject-ID entry: the account whose email was never verified loses access at once.
    await mf.setOptions(options({ ...BINDINGS, ALLOWED_GOOGLE_ACCOUNTS: 'owner@example.com' }));
    const unverified = await call('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${unverifiedToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(unverified.status).toBe(403);

    await mf.setOptions(options({ ...BINDINGS, ALLOWED_GOOGLE_ACCOUNTS: 'someone-else@example.com' }));
    const mcp = await call('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${next.access_token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(mcp.status).toBe(403);
    const second = await refresh(next.refresh_token);
    expect(second.status).toBe(400);
    expect(revoked).toContain('1//rt-owner');
  });
});
