import { describe, expect, it } from 'vitest';
import { consentPage, escapeHtml, pageCsp } from '../../src/core/html';
import { plainText } from '../../src/core/untrusted';

describe('plainText', () => {
  it('removes invisible, bidi and tag characters', () => {
    const hidden = String.fromCodePoint(0xe0049, 0xe0047, 0xe004e); // invisible "tag" letters
    expect(plainText(`a​b‮c﻿d${hidden}`, 100)).toBe('abcd');
  });
  it('strips markup and collapses whitespace', () => {
    expect(plainText('hello   <img src=x onerror=alert(1)>  world', 100)).toBe('hello world');
  });
  it('normalises lookalike characters', () => {
    expect(plainText('ｉｇｎｏｒｅ', 100)).toBe('ignore');
  });
  it('truncates long text', () => {
    expect(plainText('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`);
  });
  it('returns empty text for non-strings', () => {
    expect(plainText({ evil: true }, 10)).toBe('');
  });
});

describe('consent page', () => {
  it('escapes everything the client controls', () => {
    const html = consentPage({
      clientName: '<script>alert(1)</script>',
      redirectHost: '"><img src=x>',
      redirectIsLoopback: false,
      handle: '"onmouseover="x',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('"><img');
    expect(html).toContain(escapeHtml('<script>alert(1)</script>'));
    expect(html).toContain('App (self-named)');
    expect(html).not.toMatch(/<script/i);
  });
  it('warns for loopback clients and shows a verified domain', () => {
    const html = consentPage({ clientName: 'X', clientDomain: 'claude.ai', redirectHost: 'localhost', redirectIsLoopback: true, handle: 'h' });
    expect(html).toContain('Verified domain');
    expect(html).toContain('runs on this computer');
  });
  it('builds a CSP with no scripts and no framing', () => {
    const csp = pageCsp(["'self'", 'https://accounts.google.com']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('script-src');
  });
});
