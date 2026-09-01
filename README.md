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

The ten tools below define the initial public tool surface. Currently three are implemented — `engineering.vps.health`, `engineering.vps.capacity` and `engineering.vps.what_changed`; the remaining seven are planned for the v0.1 surface (see [Available tools](#available-tools) below).

| # | Tool | Answers | Status |
|---:|------|---------|--------|
| 1 | `engineering.vps.health` | Is my VPS healthy? | IMPLEMENTED |
| 2 | `engineering.vps.why_down` | Why is my VPS or application having a problem? | PLANNED |
| 3 | `engineering.deploy.status` | Is my deployment working? | PLANNED |
| 4 | `engineering.vps.capacity` | Is my VPS close to its limits? | IMPLEMENTED |
| 5 | `engineering.vps.what_changed` | What changed recently? | IMPLEMENTED |
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

- **Three public Simple Tools implemented:** the MCP server ships `engineering.vps.health`, `engineering.vps.capacity` and `engineering.vps.what_changed` (read-only, deterministic, evidence-based). Note: `what_changed` is session-scoped — it compares only observations made by the running MCP process; restarting the server resets its baseline, and it has no visibility into anything before that baseline. The other seven tools of the catalog are planned, not implemented.
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

Three tools are implemented in this MVP:

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

### `engineering.vps.what_changed`

Answers: **"What changed since the previous observation made by this MCP process?"**

**Important — session scope:** this tool has no historical visibility of the VPS. It keeps its baseline and last observation only in the memory of the running MCP server process. The first call creates the baseline and restarting the server resets all history. It does **not** provide deployment, file, service, container, configuration or user-action history, and never infers one.

**Input:** exactly `{}` — no parameters; extra properties are rejected.

**Output:** a deterministic status plus the observed changes:

- `BASELINE_CREATED` — first observation of this process; nothing could be compared yet (`changes` is empty). The tool never claims any knowledge from before this baseline.
- `CHANGED` — one or more observed differences above the documented thresholds since the previous observation of this process.
- `NO_CHANGE` — no observed evidence changed above the thresholds since the previous observation of this process. This does **not** mean nothing changed on the VPS outside the evidence this tool observes.
- `UNKNOWN` — essential evidence was unavailable or inconsistent (including a change of total memory between observations); nothing is fabricated and the previous observation is kept for the next comparison.

Significance thresholds (raw values are compared; rounding is display-only):

- CPU count differs → `cpuCount` change
- uptime decreased → `reboot` change (factual only; no cause is claimed)
- free memory changed by more than 1% of total memory → `memory` change
- 1-minute load per CPU changed by more than 0.5 → `cpu` change

Each reported change carries a factual `description` plus real `before`/`after` values. `observationsSinceBaseline` counts the successful observations of this process (first call = 1, second = 2, and so on), and `baselineCapturedAt` is the ISO UTC timestamp of the session's first successful observation.

Nothing beyond these three tools (Docker, deployments, logs, etc.) is implemented yet — the remaining seven tools are part of the planned catalog above.

## Quick validation

From the repository root:

```bash
npm run typecheck
npm test
```

Expected current state: **52 tests passing**.

## License

[Apache License 2.0](LICENSE)
