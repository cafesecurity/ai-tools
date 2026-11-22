# ai-tools

Small, self-contained tools that go with the AI x Cybersecurity videos.

- **AI Agent Check**: [open the tool](https://cafesecurity.github.io/ai-tools/agent-check/) · [source](agent-check/). Can we say yes to this AI agent? The three risk factors, the four doors, an approval decision, the controls that get to approval, and an approval record. From the video [Securing AI Agents at Work](https://youtu.be/QffClw8TdN4).
- **ARTEX teardown**: [read the report](artex-teardown/). What the source code of ARTEX, the AI hacking tool the FBI warned about in November 2026, says about how it works, which safety features it switches off, and how to spot it. A briefing and action list for CISOs and business leaders, then the evidence for defenders, with a file and line for every claim.
- **YouTube MCP server**: [source and deploy guide](youtube-mcp/). A read-only, single-owner MCP server for your own channel's analytics, so an AI assistant can answer questions about views, retention and traffic. You deploy your own copy (Cloudflare Workers adapter included). Its [threat model](youtube-mcp/THREAT_MODEL.md) maps each risk to the control that handles it.
