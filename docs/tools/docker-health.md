# Docker Health

Check Docker/container health without giving the AI access to the Docker socket — one operator-controlled evidence file, aggregate verdict, zero Docker authority for the agent.

## What it answers

Whether the operator's configured container workload is currently healthy, as an aggregate: is the runtime reported available, are all containers running, or are some unhealthy, restarting, stopped or unknown?

## Tool

`engineering.docker.health`

## Example questions

- "Are my containers healthy?"
- "Is anything restarting or unhealthy in my Docker workload right now?"

## What it uses

One operator-controlled structured JSON evidence file configured via `MEMORYOS_VPS_GUARDIAN_DOCKER_HEALTH_FILE`, produced by the operator's own monitoring stack outside this process. The variable is read once at server startup; the AI can never select or change the path, and no tool argument carries evidence.

**The tool does NOT execute Docker commands itself**: no Docker socket, no Docker Engine API, no docker CLI, no shell, no SSH, no child processes, no network.

## Example result

Illustrative, matching the real output contract:

```json
{
  "status": "DEGRADED",
  "summary": "DEGRADED: 1 container(s) reported unhealthy.",
  "source": "operator-docker-health",
  "observedAt": "2026-09-02T12:00:00Z",
  "evidenceAgeSeconds": 15,
  "containers": { "total": 5, "running": 4, "unhealthy": 1, "restarting": 0, "stopped": 0, "unknown": 0 },
  "findings": ["... factual count-based findings ..."],
  "limitations": ["... fixed deterministic list ..."]
}
```

## How to interpret it

- `HEALTHY` — the runtime is reported available and all configured containers are running.
- `DEGRADED` — the runtime is reported unavailable, or any container is unhealthy, restarting or stopped.
- `UNKNOWN` — required state is incomplete, any container state is unknown, or the aggregate counts are internally inconsistent; missing data is never converted into HEALTHY or DEGRADED.
- `UNAVAILABLE` — no evidence source is configured, or it returned no valid evidence.

Aggregate consistency is validated (running + unhealthy + restarting + stopped + unknown must equal total); inconsistent evidence is reported as UNKNOWN, never patched.

## Safety model

Read-only and advisory. Evidence is aggregate counts only — no container names, IDs, images, labels, mounts, commands or raw inspect data are ever exposed. Input is strictly `{}`: the agent cannot select a container, host, path, socket or filter. No mutation, no recovery, no deployment authority.

## Limitations

The verdict is computed independently of the other tools; contradictory states with [app-health](app-health.md) or [deploy-status](deploy-status.md) remain possible and are reported as observed. Zero-configuration: without the environment variable the tool stays registered and truthfully answers UNAVAILABLE.

## Related tools

- [vps-why-down](vps-why-down.md) — includes the Docker signal in cross-evidence synthesis.
- [logs-explain](logs-explain.md) — explains log signals such as healthcheck failures.
- [app-health](app-health.md) — the application-health answer from its own source.
