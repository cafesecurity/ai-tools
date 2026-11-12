# Security

## Reporting a problem

Please report security issues privately through GitHub's **Report a vulnerability** button on this repository (Security tab), not in a public issue. Include what you found, how to reproduce it and the commit you tested. You'll get an acknowledgement within a week.

## What this project promises

- **Read-only.** No tool can change a YouTube channel, and the server refuses a Google sign-in that grants more than read-only access.
- **Single owner.** Only Google accounts on the operator's allowlist can sign in; only MCP clients whose exact redirect address the operator approved can connect.
- **No token passthrough.** MCP clients get this server's own tokens, bound to its `/mcp` address. Google tokens stay on the server, encrypted at rest.
- **No secrets or personal settings in the repository.** The Google client secret is set with the platform's secret store, and your own settings live in a git-ignored `wrangler.local.jsonc`. CI scans every push for credential patterns.
- **Untrusted text is sanitised and labelled.** Comments (off by default) and titles are returned as plain text with hidden characters, markup and Markdown links removed; comments come in a field named `untrusted_text`.
- **Rate limits.** Tool calls are limited per owner (batches are refused); anonymous sign-in routes are limited per IP.

The threats considered, and the control for each, are in [THREAT_MODEL.md](THREAT_MODEL.md).

## What it doesn't protect against

- **Your own agent setup.** If the same agent session also has tools that send data out, prompt injection in comments could try to leak your analytics. Keep `ENABLE_COMMENTS` off, or keep those tools apart. See the caveat in the README.
- **A compromised Cloudflare or Google account.** Whoever controls the deployment controls the server. Use strong, phishing-resistant sign-in on both.
- **Forks.** This covers the code here. A modified copy is its operator's responsibility.

## Supply chain

- Dependencies are pinned to exact versions with a lockfile; install with `npx -y npm@11.21.2 ci` (npm itself is pinned in `packageManager`).
- npm 11 blocks install scripts except the two listed in `allowScripts` (esbuild and workerd, by exact version).
- GitHub Actions are pinned to commit SHAs and run with read-only permissions.
- Nothing is published to npm. You deploy from source you can read.
