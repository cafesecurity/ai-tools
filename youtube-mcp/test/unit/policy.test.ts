import { describe, expect, it } from 'vitest';
import { formActionSources, isAllowedAccount, isAllowedChannel, isAllowedOrigin, isAllowedRedirectUri } from '../../src/core/policy';
import { OTHER_CHANNEL, OWNER_CHANNEL, testConfig } from '../helpers';

describe('account allowlist', () => {
  const config = testConfig({ ALLOWED_GOOGLE_ACCOUNTS: 'owner@example.com sub:9876543210' });
  it('accepts a listed, verified email (case-insensitive)', () => {
    expect(isAllowedAccount(config, { sub: '1', email: 'Owner@Example.com', emailVerified: true })).toBe(true);
  });
  it('refuses a listed email that Google has not verified', () => {
    expect(isAllowedAccount(config, { sub: '1', email: 'owner@example.com', emailVerified: false })).toBe(false);
  });
  it('accepts a listed subject ID with any email', () => {
    expect(isAllowedAccount(config, { sub: '9876543210', emailVerified: false })).toBe(true);
  });
  it('refuses everyone else', () => {
    expect(isAllowedAccount(config, { sub: '2', email: 'attacker@example.com', emailVerified: true })).toBe(false);
  });
});

describe('channel pin', () => {
  it('allows any channel when unset, only listed ones when set', () => {
    expect(isAllowedChannel(testConfig(), OTHER_CHANNEL)).toBe(true);
    const pinned = testConfig({ ALLOWED_CHANNEL_IDS: OWNER_CHANNEL });
    expect(isAllowedChannel(pinned, OWNER_CHANNEL)).toBe(true);
    expect(isAllowedChannel(pinned, OTHER_CHANNEL)).toBe(false);
  });
});

describe('redirect allowlist', () => {
  const config = testConfig();
  it('accepts only the exact listed URI', () => {
    expect(isAllowedRedirectUri(config, 'https://client.example.com/callback')).toBe(true);
    for (const uri of [
      'https://client.example.com/callback/',
      'https://client.example.com/callback?x=1',
      'https://client.example.com.evil.test/callback',
      'https://evil.test/callback',
      'http://client.example.com/callback',
      'https://user@client.example.com/callback',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(isAllowedRedirectUri(config, uri), uri).toBe(false);
    }
  });
  it('refuses loopback unless switched on', () => {
    expect(isAllowedRedirectUri(config, 'http://127.0.0.1:3000/cb')).toBe(false);
    const local = testConfig({ ALLOW_LOOPBACK_REDIRECTS: 'true' });
    expect(isAllowedRedirectUri(local, 'http://127.0.0.1:3000/cb')).toBe(true);
    expect(isAllowedRedirectUri(local, 'http://localhost:9999/cb')).toBe(true);
    expect(isAllowedRedirectUri(local, 'http://192.168.1.10:3000/cb')).toBe(false);
  });
});

describe('origin check', () => {
  it('allows server-side callers (no Origin) and listed origins only', () => {
    const config = testConfig({ ALLOWED_ORIGINS: 'https://app.example.com' });
    expect(isAllowedOrigin(config, null)).toBe(true);
    expect(isAllowedOrigin(config, 'https://app.example.com')).toBe(true);
    expect(isAllowedOrigin(config, 'https://evil.test')).toBe(false);
    expect(isAllowedOrigin(testConfig(), 'https://app.example.com')).toBe(false);
  });
});

describe('form-action sources', () => {
  it('lists self, Google and approved client origins, and no loopback by default', () => {
    const sources = formActionSources(testConfig());
    expect(sources).toEqual(["'self'", 'https://accounts.google.com', 'https://client.example.com']);
  });
});
