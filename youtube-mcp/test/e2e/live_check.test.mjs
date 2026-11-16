// The post-deploy check (scripts/live-check.mjs), run against the real bundled
// Worker behind a local HTTP listener: it must pass on a correct deployment,
// report whether new connections are open, and fail on a misconfigured one.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server;
let mf;
let base = '';
let publicUrl = '';

function options(bindings) {
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
        outboundService: () => new Response('blocked by test', { status: 599 }),
      },
    ],
  });
}

const bindings = (extra) => ({
  PUBLIC_URL: publicUrl,
  GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-secret-not-real',
  ALLOWED_GOOGLE_ACCOUNTS: 'sub:1111111111',
  ALLOWED_REDIRECT_URIS: 'https://client.example.com/callback',
  ...extra,
});

function liveCheck(url) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['scripts/live-check.mjs', url], (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, out: stdout + stderr });
    });
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string' && key !== 'host') headers.set(key, value);
    headers.set('CF-Connecting-IP', '198.51.100.7');
    const response = await mf.dispatchFetch(`${publicUrl}${req.url}`, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      redirect: 'manual',
    });
    const out = {};
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie' && key !== 'content-encoding' && key !== 'transfer-encoding') out[key] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  publicUrl = base;
  mf = new Miniflare(options(bindings({ ALLOW_NEW_CONNECTIONS: 'true' })));
  await mf.ready;
});
afterAll(async () => {
  await mf?.dispose();
  server?.close();
});

describe('live-check', () => {
  it('passes on a correct deployment and says connections are open', async () => {
    const { code, out } = await liveCheck(base);
    expect(out).not.toContain('FAIL');
    expect(out).toContain('New connections are OPEN');
    expect(code).toBe(0);
  });

  it('passes with connections closed, and says so', async () => {
    await mf.setOptions(options(bindings({})));
    const { code, out } = await liveCheck(base);
    expect(out).not.toContain('FAIL');
    expect(out).toContain('New connections are CLOSED');
    expect(code).toBe(0);
  });

  it('fails when the server is not configured for the address it is reached at', async () => {
    await mf.setOptions(options({ ...bindings({}), ALLOWED_GOOGLE_ACCOUNTS: '' }));
    const { code, out } = await liveCheck(base);
    expect(out).toContain('FAIL');
    expect(code).toBe(1);
  });

  it('refuses plain http to another machine, and paths', async () => {
    expect((await liveCheck('http://yt.example.com')).code).toBe(2);
    expect((await liveCheck('https://yt.example.com/mcp')).code).toBe(2);
  });
});
