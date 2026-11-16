# Edge rules on Cloudflare (free plan)

Optional, and worth ten minutes if you are on the free plan. The server's own limits run *inside* the Worker, so every request, even a refused one, still counts towards the free plan's daily allowance (100,000 Worker requests and 100,000 storage reads). Rules at Cloudflare's edge stop unwanted requests before the Worker runs.

These are settings on your Cloudflare zone, not part of the Worker, so `npm run deploy` can't apply them: add them once in the dashboard under **Security → Security rules** for the zone your server's hostname is on. Replace `yt-mcp.example.com` with your hostname.

Current as of 16 November 2026. Check the linked pages before relying on the numbers.

## Rule 1 (custom rule): only your MCP client's servers may call the API

The free plan includes five custom rules. Claude connects to a custom connector from Anthropic's servers, not from your device, and Anthropic publishes the address ranges it calls from. Your browser only ever needs `/authorize` and `/callback`.

- **Expression**

  ```
  (http.host eq "yt-mcp.example.com"
   and not ip.src in {160.79.104.0/21 153.61.208.0/20}
   and not http.request.uri.path in {"/authorize" "/callback"})
  ```

- **Action:** Block

What this does and doesn't do:

- It is flood protection, not authentication. Anyone using Claude also comes from those ranges; tokens, the owner allowlist and the closed door still decide who gets in.
- The ranges are Anthropic's published outbound addresses: <https://platform.claude.com/docs/en/api/ip-addresses>. If they change, Claude stops connecting until you update the rule, so check that page first if your connector suddenly fails.
- If you use another MCP client, add the addresses it calls from, or leave this rule out.
- Run `node scripts/live-check.mjs` **before** adding this rule. Afterwards, the same check from your own machine is blocked by Cloudflare at `/mcp` and `/register` (it reports failures there), which is the rule working.

## Rule 2 (rate limiting rule): cap what any one address can send

The free plan includes one rate limiting rule per zone, counting per IP address over 10 seconds, with a 10-second block. If your zone already uses its one rule for something else, skip this.

- **Expression:** `(http.host eq "yt-mcp.example.com")`
- **Count by:** IP
- **Rate:** 20 requests per 10 seconds
- **Action:** Block for 10 seconds

With rule 1 in place this mainly limits `/authorize` and `/callback`, the two paths open to any address (and answered with a cheap refusal while new connections are closed).

## What is left

A flood from many addresses against `/authorize` or `/callback` can still use up the day's Worker requests, after which your own calls fail until midnight UTC. Nothing is disclosed. The Workers paid plan removes the daily cap.

## Sources

- Custom rules run before rate limiting rules, and a blocking rule stops the request there: <https://developers.cloudflare.com/waf/feature-interoperability/>
- Free plan: five custom rules: <https://developers.cloudflare.com/waf/custom-rules/>; one rate limiting rule, 10-second counting and mitigation periods: <https://developers.cloudflare.com/waf/rate-limiting-rules/>
- Free plan daily limits: <https://developers.cloudflare.com/workers/platform/limits/>, <https://developers.cloudflare.com/kv/platform/limits/>
- Claude connects to custom connectors from Anthropic's cloud: <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>
