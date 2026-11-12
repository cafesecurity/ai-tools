import { describe, expect, it } from 'vitest';
import { YT_ANALYTICS_READ, YT_READ, checkGrantedScopes, googleAuthorizeUrl, refreshGoogleToken } from '../../src/core/google';
import { MAX_RESPONSE_BYTES, UpstreamError, callGoogle } from '../../src/core/http';
import { fakeGoogle } from '../helpers';

const settings = { clientId: 'id.apps.googleusercontent.com', clientSecret: 's', redirectUri: 'https://yt.example.com/callback' };

describe('Google sign-in request', () => {
  it('asks only for read-only scopes, with PKCE S256, a fresh consent and no inherited scopes', () => {
    const url = new URL(googleAuthorizeUrl(settings, 'state123', 'challenge'));
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes.sort()).toEqual(['email', 'openid', YT_ANALYTICS_READ, YT_READ].sort());
    expect(scopes.some((s) => /youtube$|force-ssl|upload|partner/.test(s))).toBe(false);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('prompt')).toContain('consent');
  });
});

describe('checkGrantedScopes', () => {
  it('needs both YouTube scopes', () => {
    expect(checkGrantedScopes(`openid email ${YT_READ}`)).not.toBeNull();
    expect(checkGrantedScopes(`openid email ${YT_READ} ${YT_ANALYTICS_READ}`)).toBeNull();
  });
  it('refuses broader grants', () => {
    expect(checkGrantedScopes(`${YT_READ} ${YT_ANALYTICS_READ} https://www.googleapis.com/auth/youtube`)).not.toBeNull();
    expect(checkGrantedScopes(`${YT_READ} ${YT_ANALYTICS_READ} https://www.googleapis.com/auth/drive`)).not.toBeNull();
  });
});

describe('refreshGoogleToken', () => {
  it('maps invalid_grant to an auth error', async () => {
    const google = fakeGoogle(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    const error = await refreshGoogleToken(google.fetchImpl, settings, 'rt').catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe('auth');
  });
});

describe('callGoogle', () => {
  it('refuses hosts outside the allowlist and plain http', async () => {
    const google = fakeGoogle(() => ({ body: {} }));
    for (const url of ['https://evil.test/x', 'http://www.googleapis.com/x', 'https://www.googleapis.com.evil.test/x']) {
      await expect(callGoogle(google.fetchImpl, new URL(url))).rejects.toBeInstanceOf(UpstreamError);
    }
    expect(google.calls).toHaveLength(0);
  });
  it('never follows redirects', async () => {
    const google = fakeGoogle(() => ({ body: {} }));
    await callGoogle(google.fetchImpl, new URL('https://www.googleapis.com/x'));
    expect(google.calls[0]!.init?.redirect).toBe('manual');
    const redirecting = async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } });
    await expect(callGoogle(redirecting, new URL('https://www.googleapis.com/x'))).rejects.toThrow(/redirect/);
  });
  it('stops reading an oversized body', async () => {
    const big = 'x'.repeat(MAX_RESPONSE_BYTES + 10);
    const fetchImpl = async () => new Response(big, { status: 200 });
    await expect(callGoogle(fetchImpl, new URL('https://www.googleapis.com/x'))).rejects.toThrow(/large/);
  });
});
