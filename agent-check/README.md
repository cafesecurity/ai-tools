# AI Agent Check

A one-page tool for whoever sets the rules for other people's AI agents. Open `index.html` in a browser, tick what one agent connects to, and you get:

- **The count:** three lamps (untrusted input, sensitive data, acts or sends). Any two can be fine; all three needs a person in the loop or a lamp dimmed.
- **The doors:** where you can still enforce rules (device, agent app, network, identity), given where the agent runs.
- **"Can I have one?":** yes on these terms, or not this one, not yet, with a reply you can send.
- **Getting to yes:** the controls that close each missing term. The full list is in [CONTROLS.md](CONTROLS.md).
- **A one-pager:** five questions with a "last checked" date, the bad-day steps, and what is left to fix. Copy it as text or print it.

It is a single self-contained file. Nothing you type leaves the page: there is no server, no analytics and no storage.

Eight made-up example setups are built in (an always-on assistant from the video, OpenClaw, Grok Bot, dots, Claude Duet, Muse and Hermes Agent in different configurations). They show how the count changes with the configuration; none describes how a product works by default.

From the video ["The Assistant Nobody in IT Has Met"](https://youtu.be/QffClw8TdN4). Current as of November 2026. A thinking aid, not an assessment of any product, and not legal or compliance advice.

## Sources for the ideas

- Agents Rule of Two, Meta: https://ai.meta.com/blog/practical-ai-agent-security/
- The lethal trifecta, Simon Willison: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Invoice fraud guidance, National Crime Agency: https://www.nationalcrimeagency.gov.uk/who-we-are/publications/787-invoice-fraud-infosheet/file
- NIST AI Risk Management Framework: https://www.nist.gov/itl/ai-risk-management-framework
- ISO/IEC 42001: https://www.iso.org/standard/42001
