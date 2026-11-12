# Porting to another platform

All security decisions live in `src/core` and use only web-standard APIs (`fetch`, Web Crypto, streams). `src/platforms/cloudflare/worker.ts` is the only Cloudflare-specific file. A port to another runtime (Node, Deno, Bun, a container) needs an adapter that meets the contract below. If an item can't be met, don't ship the port.

## The contract

**Configuration**
- Read the settings in `RawSettings` (`src/core/config.ts`) from the environment, with `GOOGLE_CLIENT_SECRET` from a secret store, never a file in the repository.
- Call `parseConfig`. If it fails, refuse every sign-in and every `/mcp` call (fail closed), and log only the number of problems.
- Refuse requests whose origin isn't `PUBLIC_URL`.
- Limit `/authorize`, `/callback`, `/token` and `/register` per client IP, with a limiter separate from the owner's.

**OAuth authorization server (for MCP clients)**
- OAuth 2.1 authorization code flow with **PKCE S256 only** (refuse `plain` and missing PKCE).
- Publish RFC 9728 protected resource metadata for `${PUBLIC_URL}/mcp` and RFC 8414 authorization server metadata.
- Bind tokens to the resource (RFC 8707) and **check the audience on every `/mcp` call**.
- Return `iss` on authorization responses (RFC 9207).
- Store tokens as hashes and grant data encrypted; never log tokens or codes.
- Client registration (if offered) and every authorization request: accept only when `isAllowedRedirectUri` is true for **every** redirect URI. Render refusals locally; never redirect to an unapproved URI.
- Show the consent page (`consentPage`) on every authorization, never remembered, bound to the browser with a single-use, signed handle (CSRF), with the CSP from `pageCsp(formActionSources(config))` and framing denied.
- Token exchange and other grant types: off.

**OAuth client (to Google)**
- Use `googleAuthorizeUrl`, `exchangeCode`, `checkGrantedScopes`, `fetchIdentity`, `refreshGoogleToken` and `revokeGoogleToken` from `src/core/google.ts` as they are.
- Carry a fresh PKCE verifier and a single-use `state` bound to the browser across the Google round trip.
- At the callback, check the redirect allowlist again before exchanging the code.
- After sign-in, accept only if `checkGrantedScopes` passes, `isAllowedAccount` is true and `isAllowedChannel` is true for the account's own channel. Otherwise revoke what Google issued.
- Store the account's email only if Google verified it (later re-checks treat a stored email as verified).
- Keep the Google refresh token only with the grant, encrypted. Give each MCP access token a Google access token that lasts at least as long as it does (and refuse with `401` if it hasn't), and never return Google tokens to the client.
- On refresh: re-check the allowlists (revoke and refuse if no longer allowed); map Google's `invalid_grant` to `invalid_grant`.

**MCP endpoint (`/mcp`)**
1. Validate the bearer token and audience.
2. Refuse browser origins not in `ALLOWED_ORIGINS` (`isAllowedOrigin`).
3. Require the `youtube:read` scope.
4. Re-check `isAllowedAccount` and `isAllowedChannel` against the token's stored identity.
5. Refuse an expired Google access token with `401 invalid_token`.
6. Refuse JSON-RPC batches (a body that is a JSON array), reading the body with a size cap.
7. Build a fresh server per request with `buildServer`, passing the owner's channel, `config.enableComments`, and an `allowCall` that rate-limits **each tool call** per owner (use the platform's shared limiter where one exists).

**Outbound network**
- Only `callGoogle` (fixed Google hosts, https, no redirects, 10 s timeout, 2 MB cap). If you enable client ID metadata documents, fetch them only from public addresses (no private, loopback or link-local IPs).

## Proving it

Port `test/e2e/flow.test.ts` to drive your adapter. Every case in it, including the refusals, must pass before a port is used.
