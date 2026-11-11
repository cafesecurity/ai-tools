# AI Agent Check

A one-page tool for whoever sets the rules for other people's AI agents. Open `index.html` in a browser, tick what one agent connects to, and you get:

- **Risk factors:** untrusted input, sensitive data, and the ability to act or send data out (the video shows them as three lamps). Any two can be managed; all three need human approval or one factor removed.
- **Which agent:** pick Grok Bot, dots, Claude Duet, Muse, OpenClaw, Hermes Agent or a custom agent. Each shows key facts as of November 2026, whether a company-controlled plan exists, the settings that help, and a link to current docs. Where no company plan exists, "can I have one?" says so.
- **Common MCP servers:** ten popular servers (GitHub, Slack, Google Drive, Notion, Jira and Confluence, Salesforce, Asana, Supabase, a Playwright browser and the filesystem server), each with the settings that decide which risk factors it adds, the settings that help, a real incident where one is public, and a link to its current docs.
- **The doors:** where you can still enforce rules (device, agent app, network, identity), given where the agent runs.
- **"Can I have one?":** yes on these terms, or not this one, not yet, with a reply you can send.
- **Getting to yes:** the controls that close each missing term. The full list is in [CONTROLS.md](CONTROLS.md).
- **A one-pager:** five questions with a "last checked" date, the bad-day steps, and what is left to fix. Copy it as text or print it.

It is a single self-contained file. Nothing you type leaves the page: there is no server, no analytics and no storage.

Eight made-up example setups are built in (an always-on assistant from the video, OpenClaw, Grok Bot, dots, Claude Duet, Muse and Hermes Agent in different configurations). They show how the count changes with the configuration; none describes how a product works by default.

From the video ["Securing AI Agents at Work"](https://youtu.be/QffClw8TdN4). Current as of November 2026. A thinking aid, not an assessment of any product, and not legal or compliance advice.

## Disclaimer

Use at your own risk. This tool is provided as is, with no warranty. Products, settings and MCP servers change quickly: the server details were checked against each vendor's own documentation on 11 November 2026 and may since be out of date or incomplete, so check the current docs before relying on them. The lamps show what a server can do depending on how it is set up; they are not a security rating or a verdict on any product. Nothing here is a security assessment, a guarantee, or legal, compliance or other professional advice, and responsibility for securing your systems and data stays with you and your organisation.

## Updating the server list

The agents live in the `AGENTS` list and the servers in the `SERVERS` list near the top of the script in `index.html`. Each option says which risk factors it adds. If a server has changed, or you'd like one added, open an issue with a link to the vendor's docs.

## Sources for the ideas

- Agents Rule of Two, Meta: https://ai.meta.com/blog/practical-ai-agent-security/
- The lethal trifecta, Simon Willison: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Invoice fraud guidance, National Crime Agency: https://www.nationalcrimeagency.gov.uk/who-we-are/publications/787-invoice-fraud-infosheet/file
- NIST AI Risk Management Framework: https://www.nist.gov/itl/ai-risk-management-framework
- ISO/IEC 42001: https://www.iso.org/standard/42001
