#!/usr/bin/env node
// Checks a deployed copy from the outside, with no credentials: that it is the
// server you think it is, that it refuses what it should, and whether new
// connections are open or closed. Run it after every deploy:
//
//   node scripts/live-check.mjs https://yt-mcp.example.com
//
// It sends about eight anonymous requests (well under the per-IP limit) and
// changes nothing. It can't check a signed-in session: connect your client for that.

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
let origin;
try {
  origin = new URL(base);
} catch {
  origin = null;
}
const local = origin && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
if (!origin || origin.pathname !== '/' || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local))) {
  console.error('usage: node scripts/live-check.mjs https://your-server.example.com   (the origin only, no path)');
  process.exit(2);
}

const results = [];
const record = (ok, name, detail = '') => results.push({ ok, name, detail });
const get = (path, init = {}) => fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
const text = (value) => String(value ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 160);

async function check(name, run) {
  try {
    const problem = await run();
    record(!problem, name, problem ?? '');
  } catch (error) {
    record(false, name, `request failed: ${text(error?.message)}`);
  }
}

await check('describes /mcp as the protected resource', async () => {
  const response = await get('/.well-known/oauth-protected-resource/mcp');
  if (response.status !== 200) return `status ${response.status}`;
  const body = await response.json();
  if (body.resource !== `${base}/mcp`) return `resource is ${text(body.resource)}, expected ${base}/mcp (is PUBLIC_URL right?)`;
  if (!Array.isArray(body.authorization_servers) || body.authorization_servers[0] !== base) return 'authorization server is not this origin';
});

await check('authorization metadata: this issuer, PKCE S256 only', async () => {
  const response = await get('/.well-known/oauth-authorization-server');
  if (response.status !== 200) return `status ${response.status}`;
  const body = await response.json();
  if (body.issuer !== base) return `issuer is ${text(body.issuer)}`;
  const methods = body.code_challenge_methods_supported ?? [];
  if (!methods.includes('S256') || methods.includes('plain')) return `PKCE methods: ${text(methods)}`;
  for (const key of ['authorization_endpoint', 'token_endpoint']) {
    if (!String(body[key] ?? '').startsWith(`${base}/`)) return `${key} points elsewhere: ${text(body[key])}`;
  }
});

const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

await check('refuses /mcp without a token, and says where to sign in', async () => {
  const response = await get('/mcp', { method: 'POST', headers: mcpHeaders, body: rpc });
  if (response.status !== 401) return `status ${response.status} (expected 401)`;
  if (!/resource_metadata=/.test(response.headers.get('www-authenticate') ?? '')) return 'no resource_metadata in WWW-Authenticate';
});

await check('refuses /mcp with a made-up token', async () => {
  const response = await get('/mcp', { method: 'POST', headers: { ...mcpHeaders, Authorization: 'Bearer live-check:made-up:token' }, body: rpc });
  if (response.status !== 401) return `status ${response.status} (expected 401)`;
});

let connections = 'unknown';
await check('refuses to register an app that is not approved', async () => {
  const response = await get('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'live-check', redirect_uris: ['https://not-approved.invalid/callback'], token_endpoint_auth_method: 'none' }),
  });
  if (response.status === 403) connections = 'closed';
  else if (response.status === 400) connections = 'open';
  else return `status ${response.status} (expected 400, or 403 when new connections are closed)`;
});

await check('never redirects an unapproved app from /authorize', async () => {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'live-check',
    redirect_uri: 'https://not-approved.invalid/callback',
    state: 'x',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    resource: `${base}/mcp`,
  });
  const response = await get(`/authorize?${query}`);
  if (response.headers.get('location')) return `redirected to ${text(response.headers.get('location'))}`;
  if (response.status < 400 || response.status >= 500) return `status ${response.status} (expected a 4xx refusal page)`;
  if (response.headers.getSetCookie().length) return 'set a cookie for a refused request';
});

await check('pages forbid scripts and framing', async () => {
  const response = await get('/');
  const csp = response.headers.get('content-security-policy') ?? '';
  if (!csp.includes("default-src 'none'") || !csp.includes("frame-ancestors 'none'")) return `Content-Security-Policy: ${text(csp) || 'missing'}`;
  if (response.headers.get('x-content-type-options') !== 'nosniff') return 'X-Content-Type-Options missing';
});

let failed = 0;
for (const { ok, name, detail } of results) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}
console.log('');
if (connections === 'open') {
  console.log('New connections are OPEN. That is right while you connect your client. Once it is connected, set');
  console.log('ALLOW_NEW_CONNECTIONS to "false" in wrangler.local.jsonc, run `npm run deploy`, and run this check again.');
} else if (connections === 'closed') {
  console.log('New connections are CLOSED: nobody can start a sign-in. Existing connections keep working.');
}
console.log('Not checked here: that the Worker has no second address. In the Cloudflare dashboard, confirm workers.dev and preview URLs are off.');
console.log(failed ? `${failed} check(s) failed.` : 'All checks passed.');
process.exit(failed ? 1 : 0);
