# Public Scope

This document defines what MemoryOS VPS Guardian includes in the public v0.1 scope and what remains private. It is a scope statement, not a schedule.

## PUBLIC — v0.1

- **MCP server/package foundation** — the installable package skeleton and MCP entry point.
- **Ten Simple Tools** — the public tool surface listed in the README (`engineering.vps.*`, `engineering.app.health`, `engineering.deploy.*`, `engineering.logs.explain`). Each tool has a dedicated documentation page under [`docs/tools/`](tools/).
- **Public schemas/types** — input/output contracts for the public tools.
- **Public documentation** — security model, scope, usage and operational guidance.
- **Examples** — configuration and example sessions demonstrating safe usage.
- **Installation/configuration** — how to install, configure and run the public MCP server.
- **Safe adapter contracts (as needed)** — narrow interfaces that let the public tools connect to a user's own deployment/monitoring mechanisms, without shipping internal orchestration.

## OUT OF PUBLIC V0.1 SCOPE — PRIVATE

- **MemoryOS internal orchestration** — internal coordination flows and runtime behavior.
- **Guardian advanced coordination** — layered supervision/classification logic beyond the public tools.
- **Recovery intelligence** — automated recovery decision-making and its heuristics.
- **Proprietary policies** — internal operational policies and tuning.
- **Internal memory architecture** — durable memory design and storage details.
- **Production credentials/configuration** — nothing sensitive belongs in this repository.
- **Private deployment infrastructure** — internal hosting, pipelines and environments.
- **Unrestricted operational primitives** — raw shell/SSH-style capabilities are never published here.

## Future public equivalents

Items listed as private may receive public equivalents later — for example a simplified, public adapter for a capability that exists internally today. Any such decision is made per item and **without roadmap commitment**. The absence of a private item from this repository is intentional scoping, not a defect.
