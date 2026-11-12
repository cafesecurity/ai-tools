// Who may sign in, which apps may connect, and which browser origins may call.
// All checks fail closed. Platform-neutral.

import { type Config, isLoopbackHost } from './config';

export interface GoogleIdentity {
  sub: string;
  email?: string;
  emailVerified: boolean;
}

/** Owner allowlist: a listed Google subject ID, or a listed and verified email address. */
export function isAllowedAccount(config: Config, identity: GoogleIdentity): boolean {
  return config.allowedAccounts.some((allowed) => {
    if (allowed.kind === 'sub') return allowed.value === identity.sub;
    return identity.emailVerified && !!identity.email && allowed.value === identity.email.toLowerCase();
  });
}

/** Optional channel pin: when ALLOWED_CHANNEL_IDS is set, only those channels may be read. */
export function isAllowedChannel(config: Config, channelId: string): boolean {
  return config.allowedChannelIds.length === 0 || config.allowedChannelIds.includes(channelId);
}

/**
 * Approved MCP clients, identified by where they receive tokens: an exact,
 * listed https redirect URI, or (only when switched on) a loopback URI for a
 * local app. RFC 8252 lets a loopback client pick any port, so the port is not
 * compared.
 */
export function isAllowedRedirectUri(config: Config, uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return config.allowedRedirectUris.includes(url.toString());
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return config.allowLoopbackRedirects;
  return false;
}

/**
 * Browsers send an Origin header; server-side MCP clients don't. A request
 * from a web page is refused unless its origin is listed, which blocks DNS
 * rebinding and cross-site calls to the MCP endpoint.
 */
export function isAllowedOrigin(config: Config, origin: string | null): boolean {
  if (origin === null) return true;
  return config.allowedOrigins.includes(origin);
}

/** Where the consent page's form may send the browser: this server, Google, and approved clients. */
export function formActionSources(config: Config): string[] {
  const sources = new Set<string>(["'self'", 'https://accounts.google.com']);
  for (const uri of config.allowedRedirectUris) sources.add(new URL(uri).origin);
  if (config.allowLoopbackRedirects) {
    for (const host of ['http://localhost:*', 'http://127.0.0.1:*', 'http://[::1]:*']) sources.add(host);
  }
  return [...sources];
}
