# Security Policy

## Supported scope

The security-relevant parts of this project are the public MCP tool surface, its schemas/contracts, its documentation and its examples, as defined in [docs/PUBLIC-SCOPE.md](docs/PUBLIC-SCOPE.md). Anything outside that public scope — internal orchestration, private deployment infrastructure, or third-party environments configured by users — is out of scope for this repository.

## Reporting a vulnerability

Please report responsibly:

- **Do not open a public GitHub issue for security problems.**
- Describe the affected component, the potential impact and the minimal steps to reproduce.
- Include only the minimum detail needed to understand the report.
- Give maintainers a reasonable window to investigate and ship a fix before any public disclosure.

**Private reporting channel:** no private channel is defined yet. A private channel (for example GitHub private vulnerability reporting or a dedicated contact address) will be published in this file **before the first stable release**. Until then, please do not disclose suspected vulnerabilities publicly.

## Active exploits

- Do not publish details of active or exploitable issues before a fix is available.
- Prefer coordinated disclosure: report privately first; publish only after the fix is available and a reasonable grace period has passed.

## Never include sensitive material in issues

When opening any issue (security-related or not):

- Never paste credentials, API keys, connection strings, session material or any other sensitive configuration.
- Never include internal hostnames, addresses, ports or infrastructure details.
- Redact logs and configuration excerpts before posting.

## Design principles

- **Least privilege:** every tool exposes the minimum capability needed to reach its goal.
- **No unrestricted shell or SSH by default:** the public tool surface avoids giving AI agents arbitrary command execution or remote-login power.
- **Read-only by default where possible; explicit, validated boundaries for anything that changes state** (see [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)).
