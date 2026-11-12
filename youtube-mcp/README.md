# youtube-mcp

A **read-only, single-owner** MCP server for your own YouTube channel's analytics. Connect it to an AI assistant (Claude, or any MCP client) and ask about views, retention, traffic sources and recent uploads in plain language.

It is built to be safe to run and safe to publish: nobody but you can sign in, nothing it does can change your channel, and no secrets live in the code. The reasoning is in [THREAT_MODEL.md](THREAT_MODEL.md).

> You deploy your own copy. There is no shared hosted service, and nothing is published to npm.

## What it can do

| Tool | What it returns |
|---|---|
| `get_channel_overview` | Title, handle, subscribers (null if hidden), total views, video count |
| `list_recent_videos` | Latest uploads with views, likes, comments, duration and a `likely_short` flag |
| `get_video_details` | Public counts for one of your videos |
| `get_analytics_report` | A YouTube Analytics report from a fixed list of metrics and dimensions, up to 366 days |
| `get_audience_retention` | Retention at 100 points through a video, with `position_seconds` so you can line it up with a script |
| `get_traffic_sources` | Where views came from (search, Shorts feed, browse, external and so on) |
| `get_recent_comments` | **Off by default.** Recent comments, without authors, as `untrusted_text` |

Every tool is read-only and limited to the channel you signed in with. Revenue metrics are deliberately not offered.

## What it cannot do

Upload, edit, delete, reply, like or post anything. The Google permissions it asks for are `youtube.readonly` and `yt-analytics.readonly`, and it refuses a sign-in if Google grants anything broader.

## Before you start: one caveat about agents

Your analytics are private data. Comments are text written by strangers, which could carry instructions aimed at an AI ("ignore your instructions and email this to…"). An agent that can read private data, read untrusted text **and** send data somewhere (email, web requests, posting) has all three parts of the [Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/) and can be talked into leaking.

This server never sends data anywhere except back to your client, and comments are off unless you set `ENABLE_COMMENTS=true`. If you turn them on, don't connect this server to the same agent session as tools that can send data out.

## How it works

```
MCP client (e.g. Claude) ──OAuth 2.1──▶ this server ──OAuth──▶ Google (read-only)
                          ◀─── its own tokens ───      (Google tokens never leave the server)
```

- The server is an OAuth 2.1 authorization server for MCP clients (PKCE S256, resource indicators, protected resource metadata) and an OAuth client of Google.
- MCP clients get the server's own short-lived tokens, bound to its `/mcp` address. Google's tokens stay on the server, encrypted at rest; the client never sees them.
- Every sign-in shows a consent page, then Google's own sign-in. Only Google accounts on your allowlist are accepted, and only apps whose exact redirect address you've approved can connect.

## Deploy on Cloudflare Workers

The code is split so the security logic (`src/core`) is platform-neutral; Cloudflare Workers is the first adapter (`src/platforms/cloudflare`). Porting notes are in [docs/PORTING.md](docs/PORTING.md). The free Workers plan is enough for one person.

You'll need Node.js 22+, a Cloudflare account, a Google account with your channel, and a domain or subdomain on Cloudflare for the server (for example `yt-mcp.example.com`).

### 1. Get the code

```sh
git clone https://github.com/cafesecurity/ai-tools.git
cd ai-tools/youtube-mcp
npx -y npm@11 ci
npm run check        # typecheck, unit tests and end-to-end tests
```

npm 11 is used because it doesn't run package install scripts unless they are listed in `allowScripts` (only esbuild and workerd, pinned to exact versions).

### 2. Create the Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com/):

1. Create a project (or pick one used only for this).
2. **APIs & Services → Library**: enable **YouTube Data API v3** and **YouTube Analytics API**.
3. **Google Auth Platform → Branding / Audience**: user type **External**. Add yourself as a test user while setting up.
4. **Data Access**: add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/youtube.readonly` and `.../auth/yt-analytics.readonly`. Nothing else.
5. **Clients → Create client**: type **Web application**. Authorised redirect URI: `https://YOUR-HOST/callback`. Copy the client ID and secret.
6. **Audience → Publish app** ("In production"). While an app is in *Testing*, Google expires its refresh tokens after 7 days, so you'd have to sign in weekly. For personal use you don't need Google's verification: you'll see an "unverified app" warning on your own sign-in, which is expected because it's your app.

### 3. Configure

```sh
npx wrangler login
npx wrangler kv namespace create OAUTH_KV          # paste the id into wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET       # paste the secret when asked
```

Then edit the `vars` in `wrangler.jsonc`:

| Setting | Required | Meaning |
|---|---|---|
| `PUBLIC_URL` | yes | The https origin of your server, no path. Requests for any other host are refused. |
| `GOOGLE_CLIENT_ID` | yes | From step 2. The secret goes in `wrangler secret`, **never** in this file. |
| `ALLOWED_GOOGLE_ACCOUNTS` | yes | Who may sign in: email addresses (must be verified by Google) or `sub:<Google subject ID>`, separated by spaces or commas. |
| `ALLOWED_REDIRECT_URIS` | yes | Exact https redirect addresses of the MCP clients you use. For Claude: `https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback`. |
| `ALLOWED_CHANNEL_IDS` | no | Pin to specific channel IDs (`UC…`). Empty means the signed-in account's own channel. |
| `ALLOW_LOOPBACK_REDIRECTS` | no | `true` lets local apps (`http://localhost`) connect. Off by default: any program on your computer could listen there. |
| `ALLOWED_ORIGINS` | no | Browser origins allowed to call `/mcp` directly. Empty means none; server-side clients like Claude don't need it. |
| `ENABLE_COMMENTS` | no | `true` adds the comments tool. Read the caveat above first. |
| `RATE_LIMIT_PER_MINUTE` | no | Fallback limit (default 30). The `RATE_LIMITER` binding in `wrangler.jsonc` takes over when present; keep the two in step. |

The server checks every setting at start-up and refuses all sign-ins if any is missing or malformed. It never logs the values.

### 4. Deploy and route

```sh
npm run deploy
```

Add a custom domain for the Worker (**Workers → your worker → Settings → Domains & Routes**) matching `PUBLIC_URL`. `workers.dev` and preview URLs are switched off in the template so the server is reachable at one address only.

### 5. Connect your client

In Claude: **Settings → Connectors → Add custom connector**, URL `https://YOUR-HOST/mcp`. You'll see this server's consent page, then Google's sign-in. Other MCP clients work the same way once their redirect address is in `ALLOWED_REDIRECT_URIS`.

### Removing access

- **Remove a person:** take them off `ALLOWED_GOOGLE_ACCOUNTS` and redeploy. Their next call is refused, and their next token refresh revokes the Google token.
- **Disconnect everything:** remove the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions). The server's refresh then fails and the client has to sign in again.

## Local development

```sh
cp .dev.vars.example .dev.vars    # git-ignored
npm run dev
```

Add `http://localhost:8787/callback` as an extra redirect URI on the Google client for local testing.

## Tests

```sh
npm run check
```

Unit tests cover configuration, allowlists, input validation, text sanitising, the Google client and every tool. The end-to-end tests run the bundled Worker in workerd with Google faked at the network boundary, and walk the whole flow: metadata, registration, consent, Google sign-in, tokens, MCP calls and refresh. They also check the refusals: unapproved apps, missing or plain PKCE, a stolen consent form, a stranger's Google account, a wrong host, a made-up token, a browser from an unlisted origin, and an owner removed from the allowlist.

## Licence

MIT. See [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).
