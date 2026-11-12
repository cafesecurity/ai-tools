# Threat model

This server lets an AI assistant read **one person's own YouTube channel analytics**. It never changes anything on YouTube. This document says what could go wrong, and which control in the code stops it. It follows the method used in the AI x Cybersecurity series: the FBI questions (Feed, Behaviour, Impact), the Agents Rule of Two, the five MCP builder rules, and the MCP authorization spec (revision 2026-07-28).

Current as of November 2026. Specs and libraries change; re-check before relying on this.

## What it is

```
MCP client (e.g. Claude)  ──OAuth 2.1 + PKCE──▶  this server  ──Google OAuth (read-only)──▶  YouTube Data + Analytics APIs
        ▲                                         │
        └────────── read-only tool results ◀──────┘
```

- This server is two things at once: the **OAuth authorization server** for MCP clients (it issues its own tokens), and an **OAuth client** of Google (it holds a Google token for the owner).
- One deployment serves **one owner**. Anyone can deploy their own copy for their own channel; no copy serves strangers.
- The authorization server role comes from a maintained library (on Cloudflare: `@cloudflare/workers-oauth-provider`). The policy on top of it, and everything YouTube-specific, is in `src/core/`.

## Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Google refresh token (read-only YouTube scopes) | Inside the OAuth grant, encrypted at rest with a key only a valid token holder can derive | Long-lived access to the owner's private analytics |
| Short-lived Google access token | Inside each MCP access token's encrypted record; never sent to the MCP client | One hour of the same access |
| MCP access and refresh tokens | Stored only as hashes | Whoever holds one can call the tools |
| Private channel analytics, comments | Fetched on demand, never stored | Business data; comments are public but written by strangers |
| Google OAuth client secret, consent-cookie secret | Platform secret store, never in the repository | Lets someone impersonate this server to Google |

## FBI: where things enter, what decides, what it can do

- **Feed (what it reads).** Channel statistics and analytics come from Google over TLS and are trusted as data. **Comments, video titles and descriptions are written by people we don't control** (comments by the public; titles could be edited by anyone with channel access), so they are untrusted text. They are returned as plain text, length-capped, control characters removed, inside a field named `untrusted_text`, with a note telling the model to treat them as data, not instructions.
- **Behaviour (what decides).** The model decides which tool to call. Every tool is read-only, takes narrow, validated inputs (IDs by pattern, dates by format and range, metrics and dimensions from fixed allowlists) and can only see the authenticated owner's channel.
- **Impact (what it can do).** Read-only Google scopes (`youtube.readonly`, `yt-analytics.readonly`), plus `openid email` to identify the owner. No tool writes, deletes, posts, uploads, sends messages or calls arbitrary URLs. The worst case of a misused token is that someone reads the owner's analytics.

## Agents Rule of Two

An agent should combine at most two of: **(A)** untrusted input, **(B)** sensitive data or systems, **(C)** the ability to change state or communicate externally.

This server gives an agent **A** (comments) and **B** (private analytics), and **no C**. If the same agent also holds tools that can send email, post, or fetch arbitrary URLs, the combination reaches all three: injected text in a comment could try to make the agent send the analytics out. The README says so, and the comment tool is **off by default**: the operator turns it on with `ENABLE_COMMENTS=true`, and without it the server offers only A-free tools (titles of the owner's own videos are the one remaining untrusted field, and are sanitised the same way).

## Threats and controls

### Spoofing and token misuse

| Threat | Control | Where |
| --- | --- | --- |
| A stranger finds the URL and signs in with their own Google account | **Owner allowlist, fail closed.** After Google sign-in the server reads the account from Google's userinfo endpoint (over TLS, with the access token, so no ID-token parsing), and accepts only accounts listed in `ALLOWED_GOOGLE_ACCOUNTS` (by Google subject ID, or by email only when Google says the email is verified). With the list empty, nobody can sign in. The Google token of a refused account is revoked at Google straight away. | `core/policy.ts`, `platforms/cloudflare/worker.ts` (`/callback`) |
| The owner is removed from the allowlist but still holds tokens | The allowlist is checked again **on every tool call**, not only at sign-in | `worker.ts` (API handler) |
| A token minted for another server is replayed here (confused deputy) | Tokens are bound to this server's resource URL (RFC 8707) and the library rejects any token whose audience isn't this resource | library; `resourceMetadata.resource` |
| An MCP access token is used to reach Google directly | Never possible: MCP clients only ever see this server's opaque tokens. The Google token stays server-side. **No token passthrough.** | design |
| A stolen authorization code is redeemed | PKCE with S256 is mandatory for public clients; `plain` is refused; codes are single-use | library |
| Mix-up attack against the client | The authorization response carries `iss` (RFC 9207) | library |

### Approve the agent, not just the user

| Threat | Control | Where |
| --- | --- | --- |
| An unknown or malicious app registers itself and asks the owner to sign in (the "Obsidian" pattern: consent shared across clients behind one static Google app) | **Approved-client allowlist, fail closed.** Every authorization request must use a redirect URI listed exactly in `ALLOWED_REDIRECT_URIS`. Dynamic client registration refuses any client whose redirect URIs aren't all on that list. Local (loopback) redirects are off unless `ALLOW_LOOPBACK_REDIRECTS=true`. | `core/policy.ts`, `worker.ts` |
| The owner is rushed through consent | A **consent page on every authorization**, before the redirect to Google, showing the app's name (marked unverified for self-registered apps), its verified domain for client-ID-document apps, where access will be sent, and a warning for local apps. It can't be framed and the form can't be forged (browser-bound handle; request kept server-side). Consent isn't remembered. | library helpers, `core/html.ts` |
| The Google callback is replayed in another browser | `state` exists only after consent and is bound to the browser with a `__Host-` cookie; single use, ten minutes | library helpers |

### Tampering and injection

| Threat | Control | Where |
| --- | --- | --- |
| Prompt injection through comments or titles (Feed) | Returned as plain, length-capped text in `untrusted_text`, with a data-not-instructions note; HTML and control characters stripped; authors' channel IDs not returned | `core/untrusted.ts` |
| Tool arguments used to reach other channels or endpoints | Inputs validated by schema: video and channel IDs by pattern, dates by format and range, metrics, dimensions and sort keys from fixed allowlists; every per-video tool first checks the video belongs to the owner's channel; Analytics queries are always `ids=channel==MINE` | `core/validate.ts`, `core/youtube.ts` |
| Outbound requests sent somewhere else (SSRF) | Google endpoints are constants, never configuration; outbound calls go only to a fixed list of Google hosts over https, never follow redirects (any 3xx is refused), time out after 10 s and stop reading after 2 MB | `core/http.ts` |
| Script injection on the consent page through a client's self-chosen name | Everything from a client is escaped; strict Content-Security-Policy (`default-src 'none'`), no framing | `core/html.ts` |

### Information disclosure

| Threat | Control | Where |
| --- | --- | --- |
| Tokens or personal data in logs | Logs carry event names and reasons only: no tokens, codes, emails or analytics | `core/log.ts` |
| Upstream error details leak to the client | Google errors are mapped to short generic messages | `core/youtube.ts` |
| Secrets committed to the public repository | Secrets come only from the platform's secret store; `.dev.vars`, `.env` and key files are git-ignored; CI scans for secrets on every push | `.gitignore`, CI |
| A browser page on another site calls the MCP endpoint (DNS rebinding, cross-site) | Requests with an `Origin` header are refused unless the origin is listed in `ALLOWED_ORIGINS` (server-to-server MCP clients send none) | `worker.ts` |

### Denial of service and cost

| Threat | Control | Where |
| --- | --- | --- |
| Request floods burn the owner's YouTube API quota | Per-owner rate limit on tool calls; result-size caps; small `max_results` ceilings; request-body size limit | `core/ratelimit.ts`, `core/tools.ts` |
| Expensive date ranges | Analytics ranges capped at 366 days | `core/validate.ts` |

### Supply chain (publishing without risk)

| Threat | Control |
| --- | --- |
| A compromised dependency update | Exact version pins and a lockfile; `npm ci` in CI; few runtime dependencies (the MCP SDK, the OAuth library, zod) |
| Malicious install scripts | npm 11 blocks install scripts by default; only two platform-binary scripts are allowed, by exact version, in `package.json` (`allowScripts`) |
| A tampered CI action | Third-party GitHub Actions pinned to full commit SHAs; least-privilege `permissions: contents: read` |
| A lookalike package or server | Nothing is published to a package registry: you deploy from source you can read. There's no hosted instance to impersonate. |

## Out of scope, and residual risk

- **The MCP client and its agent.** A client with an approved redirect URI and the owner's consent gets the owner's analytics; that is the point. If that agent also holds send-capable tools (the third Rule-of-Two letter), comment injection could try to exfiltrate. Keep comment reading off in such agents, or don't combine them.
- **Google account compromise.** Whoever controls the owner's Google account can sign in. Use a passkey or hardware key on that account.
- **The hosting platform and the OAuth library.** Trusted. Both are widely used and maintained; keep them updated.
- **Google's "Testing" publishing status** makes Google refresh tokens expire after 7 days. Moving the Google app to "In production" (unverified is fine for personal use, with a warning screen) removes that; see the README.
- **Approving apps is the strongest control, not a guarantee.** A public desktop client can't keep a secret, so its client ID and redirect URI can be imitated on the same machine; the consent page's loopback warning and keeping loopback off by default narrow this.

## How the controls are checked

- **Unit tests** (`test/unit`) cover each control in `src/core`: configuration failing closed, the account, channel, redirect and origin allowlists, input allowlists and date limits, text sanitising, consent-page escaping and CSP, Google host and redirect refusal, the response-size cap, ownership checks, and every tool's read-only annotation.
- **End-to-end tests** (`test/e2e`) run the bundled Worker in workerd with Google faked at the network boundary. They prove the full happy path and these refusals: registration with an unapproved redirect URI, authorization without PKCE or with `plain`, a consent form posted without its browser binding, a stranger's Google account (and its token revoked), a wrong host, a made-up token, a browser from an unlisted origin, and an owner removed from the allowlist (calls refused at once, refresh refused and the Google token revoked). They also check that no Google token appears in any token response.
- **CI** runs both suites, `npm audit` for runtime dependencies and a secret scan on every push.
