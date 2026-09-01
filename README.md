# MemoryOS VPS Guardian

> Safe AI-powered VPS management through MCP.

Open-source MCP tools for VPS health, diagnostics, Docker visibility, deployment readiness, incident explanation and safe server operations — designed so AI agents do not need unrestricted SSH or shell access.

## What is MemoryOS VPS Guardian?

MemoryOS VPS Guardian defines a planned public MCP (Model Context Protocol) tool surface for observing and understanding server state. Instead of handing an AI agent a raw shell, it exposes goal-oriented tools that return structured, evidence-based answers to practical operational questions such as:

- Is my application healthy?
- Is my VPS healthy?
- Why is something down?
- Is my deployment working?
- Is it safe to deploy right now?
- What changed recently?

## Why it exists

AI agents are increasingly used to operate infrastructure. Giving them unrestricted shell or SSH access is risky: a single wrong command can take production down, and audit trails become opaque. This project exists to narrow that gap with a small, auditable set of tools that answer operational questions and perform only explicitly bounded, validated operations.

## Key principle: goal-oriented safe tools instead of unrestricted shell

- Each tool answers one specific operational goal, not arbitrary power.
- Read-only behavior is the default wherever possible.
- Mutation paths, where they exist, are explicit, allowlisted and gated behind confirmation boundaries.
- Deterministic evidence comes first; interpretation is layered on top and must never fabricate findings.

See [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) for the full public security model.

## Initial public Simple Tools catalog (planned v0.1 public tool surface)

The ten tools below define the initial public tool surface. This repository is currently at the foundation stage: this catalog describes the target v0.1 surface, not a shipped implementation.

| # | Tool | Answers |
|---:|------|---------|
| 1 | `engineering.vps.health` | Is my VPS healthy? |
| 2 | `engineering.vps.why_down` | Why is my VPS or application having a problem? |
| 3 | `engineering.deploy.status` | Is my deployment working? |
| 4 | `engineering.vps.capacity` | Is my VPS close to its limits? |
| 5 | `engineering.vps.what_changed` | What changed recently? |
| 6 | `engineering.app.health` | Is my application working? |
| 7 | `engineering.vps.incident.summary` | What is happening with my VPS right now? |
| 8 | `engineering.deploy.ready` | Is it safe to deploy now? |
| 9 | `engineering.docker.health` | Are my containers healthy? |
| 10 | `engineering.logs.explain` | What do these errors/logs mean? |

## Security model

The public tool surface follows a least-privilege, evidence-first model:

- No unrestricted shell or SSH channel is exposed to AI agents by default.
- Tools are read-only wherever possible; changing operations are explicit, bounded and validated afterwards.
- Evidence gaps are reported as such (for example UNKNOWN or insufficient evidence) and findings are never invented.

Full principles: [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md). Public vs. private scope: [docs/PUBLIC-SCOPE.md](docs/PUBLIC-SCOPE.md). Responsible disclosure: [SECURITY.md](SECURITY.md).

## Current status

- **Foundation stage.** This repository currently contains public documentation, license and project baseline only.
- No functional tool implementation is included yet.
- No stable release has been published yet.

## Planned public roadmap

1. **v0.1 — public foundation:** MCP server/package foundation, the ten Simple Tools above, public schemas/types, public documentation, examples and installation/configuration guidance.
2. **Safe adapter contracts:** narrow interfaces, as needed, that let the public tools connect to a user's own deployment/monitoring mechanisms.
3. **Documentation-driven hardening:** security-model checks, validation guidance and example configurations.
4. **Possible public equivalents of selected private capabilities:** evaluated per item, without roadmap commitment (see [docs/PUBLIC-SCOPE.md](docs/PUBLIC-SCOPE.md)).

## License

[Apache License 2.0](LICENSE)
