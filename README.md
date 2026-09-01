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

The ten tools below define the initial public tool surface. Currently two are implemented — `engineering.vps.health` and `engineering.vps.capacity`; the remaining eight are planned for the v0.1 surface (see [Available tools](#available-tools) below).

| # | Tool | Answers | Status |
|---:|------|---------|--------|
| 1 | `engineering.vps.health` | Is my VPS healthy? | IMPLEMENTED |
| 2 | `engineering.vps.why_down` | Why is my VPS or application having a problem? | PLANNED |
| 3 | `engineering.deploy.status` | Is my deployment working? | PLANNED |
| 4 | `engineering.vps.capacity` | Is my VPS close to its limits? | IMPLEMENTED |
| 5 | `engineering.vps.what_changed` | What changed recently? | PLANNED |
| 6 | `engineering.app.health` | Is my application working? | PLANNED |
| 7 | `engineering.vps.incident.summary` | What is happening with my VPS right now? | PLANNED |
| 8 | `engineering.deploy.ready` | Is it safe to deploy now? | PLANNED |
| 9 | `engineering.docker.health` | Are my containers healthy? | PLANNED |
| 10 | `engineering.logs.explain` | What do these errors/logs mean? | PLANNED |

## Security model

The public tool surface follows a least-privilege, evidence-first model:

- No unrestricted shell or SSH channel is exposed to AI agents by default.
- Tools are read-only wherever possible; changing operations are explicit, bounded and validated afterwards.
- Evidence gaps are reported as such (for example UNKNOWN or insufficient evidence) and findings are never invented.

Full principles: [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md). Public vs. private scope: [docs/PUBLIC-SCOPE.md](docs/PUBLIC-SCOPE.md). Responsible disclosure: [SECURITY.md](SECURITY.md).

## Current status

- **Two public Simple Tools implemented:** the MCP server ships `engineering.vps.health` and `engineering.vps.capacity` (read-only, deterministic, evidence-based). The other eight tools of the catalog are planned, not implemented.
- No stable release has been published yet.

## Planned public roadmap

1. **v0.1 — public foundation:** MCP server/package foundation, the ten Simple Tools above, public schemas/types, public documentation, examples and installation/configuration guidance.
2. **Safe adapter contracts:** narrow interfaces, as needed, that let the public tools connect to a user's own deployment/monitoring mechanisms.
3. **Documentation-driven hardening:** security-model checks, validation guidance and example configurations.
4. **Possible public equivalents of selected private capabilities:** evaluated per item, without roadmap commitment (see [docs/PUBLIC-SCOPE.md](docs/PUBLIC-SCOPE.md)).

## Requirements

- [Node.js](https://nodejs.org) **18 or newer** — the minimum declared in `package.json` (`engines.node: ">=18"`). Only this floor is guaranteed by the project; no other specific versions are claimed as tested.
- npm (bundled with Node.js) to install dependencies from the public npm registry.

## Install from source

```bash
git clone https://github.com/AndersonVitaease/memoryos-vps-guardian.git
cd memoryos-vps-guardian
npm install
```

## Run

```bash
npm start
```

The server runs over **MCP stdio**: it is started by the client process and communicates exclusively via standard input/output. There is no HTTP server and no network listener.

## MCP client configuration

Generic example for launching the server from source. Exact syntax varies between MCP clients — most accept a command, arguments and a working directory in some form:

```json
{
  "mcpServers": {
    "memoryos-vps-guardian": {
      "command": "npm",
      "args": ["start"],
      "cwd": "<path-to-memoryos-vps-guardian>"
    }
  }
}
```

Replace `<path-to-memoryos-vps-guardian>` with the local folder where you cloned this repository.

## Available tools

Two tools are implemented in this MVP:

### `engineering.vps.health`

**Input:** exactly `{}` — no parameters; extra properties are rejected.

**Output:** a deterministic status plus supporting evidence:

- `HEALTHY` — memory usage and 1-minute load per CPU are below the documented thresholds.
- `DEGRADED` — clear pressure detected: memory usage above 90%, or 1-minute load above 2× the CPU count.
- `UNKNOWN` — essential evidence could not be obtained; no diagnosis is invented.

Evidence collected (read-only, via Node.js `os` APIs — no shell, no SSH, no network):

- uptime (seconds)
- CPU count
- 1-minute load average
- total memory (bytes)
- free memory (bytes)
- memory usage percentage

### `engineering.vps.capacity`

Answers: **"Is my VPS close to its limits?"**

**Input:** exactly `{}` — no parameters; extra properties are rejected.

**Output:** a deterministic pressure assessment with a per-component view (CPU, memory) and a global status:

- `OK` — both CPU load and memory usage are below the documented thresholds.
- `PRESSURED` — clear pressure detected on either component.
- `UNKNOWN` — essential evidence could not be obtained; no classification is invented.

Current thresholds (raw values are compared; rounding is display-only):

- memory used > 90% → `HIGH`
- 1-minute load / CPU count > 2 → `HIGH`

Evidence collected (read-only, via the same Node.js `os` APIs — no shell, no SSH, no network):

- CPU count
- 1-minute load average
- load per CPU
- total memory (bytes)
- free memory (bytes)
- memory usage percentage

Current state only: the result describes the present snapshot — no future capacity prediction and no automatic upgrade recommendation.

Nothing beyond these two tools (Docker, deployments, logs, etc.) is implemented yet — the remaining eight tools are part of the planned catalog above.

## Quick validation

From the repository root:

```bash
npm run typecheck
npm test
```

Expected current state: **26 tests passing**.

## License

[Apache License 2.0](LICENSE)
