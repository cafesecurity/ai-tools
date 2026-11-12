import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config';
import { BASE_SETTINGS } from '../helpers';

describe('parseConfig', () => {
  it('fails closed when nothing is set', () => {
    const result = parseConfig({});
    expect(result.ok).toBe(false);
  });

  it('accepts a complete configuration and derives the resource and callback', () => {
    const result = parseConfig(BASE_SETTINGS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.resource).toBe('https://yt.example.com/mcp');
    expect(result.config.googleRedirectUri).toBe('https://yt.example.com/callback');
    expect(result.config.allowLoopbackRedirects).toBe(false);
    expect(result.config.enableComments).toBe(false);
    expect(result.config.rateLimitPerMinute).toBe(30);
  });

  it.each([
    ['PUBLIC_URL', 'http://yt.example.com'],
    ['PUBLIC_URL', 'https://yt.example.com/path'],
    ['PUBLIC_URL', 'https://user:pass@yt.example.com'],
    ['GOOGLE_CLIENT_ID', 'not-a-client-id'],
    ['GOOGLE_CLIENT_SECRET', ''],
    ['ALLOWED_GOOGLE_ACCOUNTS', ''],
    ['ALLOWED_GOOGLE_ACCOUNTS', 'owner@example.com, *'],
    ['ALLOWED_CHANNEL_IDS', 'UCshort'],
    ['ALLOWED_REDIRECT_URIS', ''],
    ['ALLOWED_REDIRECT_URIS', 'http://client.example.com/callback'],
    ['ALLOWED_ORIGINS', 'https://app.example.com/path'],
    ['RATE_LIMIT_PER_MINUTE', '0'],
    ['RATE_LIMIT_PER_MINUTE', 'lots'],
  ])('refuses %s=%j', (key, value) => {
    expect(parseConfig({ ...BASE_SETTINGS, [key]: value }).ok).toBe(false);
  });

  it('never echoes setting values in its problems', () => {
    const result = parseConfig({ ...BASE_SETTINGS, GOOGLE_CLIENT_ID: 'leaky-value-123' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(' ')).not.toContain('leaky-value-123');
  });

  it('allows http only for a loopback public URL (local development)', () => {
    expect(parseConfig({ ...BASE_SETTINGS, PUBLIC_URL: 'http://localhost:8787' }).ok).toBe(true);
  });

  it('accepts sub: entries and loopback-only clients', () => {
    const result = parseConfig({
      ...BASE_SETTINGS,
      ALLOWED_GOOGLE_ACCOUNTS: 'sub:1234567890',
      ALLOWED_REDIRECT_URIS: '',
      ALLOW_LOOPBACK_REDIRECTS: 'true',
    });
    expect(result.ok).toBe(true);
  });
});

describe('template placeholders', () => {
  it.each([
    ['PUBLIC_URL', 'https://yt-mcp.example.com'],
    ['GOOGLE_CLIENT_ID', 'REPLACE.apps.googleusercontent.com'],
    ['ALLOWED_GOOGLE_ACCOUNTS', 'you@example.com'],
    ['GOOGLE_CLIENT_SECRET', 'replace-me'],
  ])('refuses to start with %s left as the placeholder', (key, value) => {
    expect(parseConfig({ ...BASE_SETTINGS, [key]: value }).ok).toBe(false);
  });
});
