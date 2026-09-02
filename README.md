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

The ten tools below define the initial public tool surface. Currently four are implemented — `engineering.vps.health`, `engineering.vps.capacity`, `engineering.vps.what_changed` and `engineering.vps.incident.summary`; the remaining six are planned for the v0.1 surface (see [Available tools](#available-tools) below).

| # | Tool | Answers | Status |
|---:|------|---------|--------|
| 1 | `engineering.vps.health` | Is my VPS healthy? | IMPLEMENTED |
| 2 | `engineering.vps.why_down` | Why is my VPS or application having a problem? | PLANNED |
| 3 | `engineering.deploy.status` | Is my deployment working? | PLANNED |
| 4 | `engineering.vps.capacity` | Is my VPS close to its limits? | IMPLEMENTED |
| 5 | `engineering.vps.what_changed` | What changed recently? | IMPLEMENTED |
| 6 | `engineering.app.health` | Is my application working? | PLANNED |
| 7 | `engineering.vps.incident.summary` | What is happening with my VPS right now? | IMPLEMENTED |
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

- **Four public Simple Tools implemented:** the MCP server ships `engineering.vps.health`, `engineering.vps.capacity`, `engineering.vps.what_changed` and `engineering.vps.incident.summary` (read-only, deterministic, evidence-based). `what_changed` is session-scoped — it compares only observations made by the running MCP process; restarting the server resets its baseline, and it has no visibility into anything before that baseline. `incident.summary` is a deterministic composition over the same evidence: it reports NORMAL, ATTENTION or UNKNOWN, never a root cause, and calling it counts as one shared change observation. The other six tools of the catalog are planned, not implemented. The application/deployment safe adapter contract (typed evidence, strict validation and pure classifiers — see [Safe adapter contract](#safe-adapter-contract-applicationdeployment-evidence) below) is implemented as a code-level seam, with no transport and no new MCP tools.
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

Four tools are implemented in this MVP:

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

### `engineering.vps.incident.summary`

Answers: **"What is happening on this VPS right now, according to local evidence?"** — a deterministic composition of the three tools above, not a new evidence source.

**Input:** exactly `{}` — no parameters; extra properties are rejected.

**Output:** a single deterministic verdict plus compact observations:

- `NORMAL` — health HEALTHY, capacity OK and no significant change observed (or the change-observation baseline was just created). A freshly created baseline is never treated as an incident or as proof of past stability.
- `ATTENTION` — one or more currently observed conditions require attention: health DEGRADED, capacity PRESSURED or a significant change observed. This is not a confirmed incident, outage or failure and never names a cause.
- `UNKNOWN` — some required evidence was unavailable or inconsistent; absence of evidence is never reported as NORMAL or ATTENTION.

`observations` contains exactly one factual note per component (`engineering.vps.health`, `engineering.vps.capacity`, `engineering.vps.what_changed`) and `limitations` is a fixed deterministic list: no causal conclusion is made; applications, services, containers, deployments and logs are not observed; change observation is scoped to this MCP process/session and facts before its baseline are unknown.

**Shared change history:** this tool uses the same session-scoped `what_changed` instance, so calling `engineering.vps.incident.summary` counts as one change observation — direct `engineering.vps.what_changed` calls and summary calls advance the same sequence.

Nothing beyond these four tools (Docker, deployments, logs, etc.) is implemented yet — the remaining six tools are part of the planned catalog above.

## Safe adapter contract (application/deployment evidence)

The code-level seam for the planned application/deployment tools (`engineering.deploy.status`, `engineering.app.health`, `engineering.deploy.ready`) is implemented, following the same injectable pattern as the host evidence adapter:

- `ApplicationDeploymentEvidence` — one typed evidence snapshot (`applicationId`, `observedAt`, `source`, `currentReleaseId`, `previousReleaseId`, `deploymentStatus`, `lastDeploymentFinishedAt`, `applicationHealthy`), where every nullable field means "the evidence source cannot observe this".
- `applicationDeploymentEvidenceSchema` with `parseApplicationDeploymentEvidence` / `tryParseApplicationDeploymentEvidence` — strict zod validation: unknown keys rejected, bounded strings, no control characters, ISO-8601 UTC timestamps only, and `lastDeploymentFinishedAt` must not be after `observedAt`. Malformed or inconsistent evidence is never repaired or guessed.
- `ApplicationDeploymentAdapter { name, collect(): evidence | null }` — a pure, side-effect-free, read-only evidence seam analogous to `SystemHealthAdapter`.
- Pure deterministic classifiers `assessApplicationHealth` (`true/false/null` → `HEALTHY/DEGRADED/UNKNOWN`), `assessDeployStatus` (`SUCCEEDED/IN_PROGRESS/QUEUED/FAILED/null` → `OK/IN_FLIGHT/PENDING/FAILED/UNKNOWN`) and `assessDeployReady` (advisory only: `READY` requires no in-flight/queued deployment, a reported-healthy application, no VPS health DEGRADED, no VPS capacity PRESSURED, and no required component UNKNOWN; it triggers nothing and grants no deployment authority).

**No transport ships with this contract.** It performs no file, socket, container-runtime, environment or credential access of any kind, and no new MCP tool is registered (the public catalog remains the four tools above). Evidence authority stays with the host process that constructs the server; MCP tool arguments never carry this evidence. Missing evidence maps deterministically to `UNKNOWN`/`UNAVAILABLE` and is never inferred.

## Release-state file transport (ReleaseStateFileAdapter)

`createReleaseStateFileAdapter({ path })` in `src/adapters/releaseStateFile.ts` is the first evidence source for the contract above: it reads **one** operator-configured local JSON file whose entire content is one `ApplicationDeploymentEvidence` document (all eight fields, including the required `source` label).

- **The path is operator-controlled and fixed at construction time.** It is validated once (string, 1–4096 characters, no control characters) and resolved once with `path.resolve()`; invalid configuration throws at construction. The MCP agent can never supply or modify the path, and no MCP tool consumes evidence through its arguments.
- **Read-only, no generic filesystem access.** The only I/O is `statSync()` + `readFileSync()` against that one absolute path — no writes, renames, deletes, directory listing, globs, watchers, polling, streams, retries, caching, or environment access, and no generic filesystem layer.
- **64 KiB hard limit** (`MAX_RELEASE_STATE_BYTES = 65536`), enforced before reading (via `stat`) and re-checked after reading.
- **Fail-closed.** A missing file, permission denied, directory/non-regular file, oversized file, empty or malformed JSON, or evidence failing the strict contract schema all map deterministically to `null` (→ `UNAVAILABLE`), never a crash, a guessed status, or partially accepted evidence. No staleness is computed here and no clock is used: `observedAt` passes through exactly as validated, and staleness display/policy belongs to the consuming MCP tool.
- **No MCP tool registers or consumes it yet**; the public catalog remains the four tools above.
- **Producer recommendation:** write a temporary file, then atomically rename it over the configured path, so readers never observe a partial write (a partial write anyway fails closed).

## Quick validation

From the repository root:

```bash
npm run typecheck
npm test
```

Expected current state: **66 tests passing**.

## License

[Apache License 2.0](LICENSE)
