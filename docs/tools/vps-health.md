# VPS Health

A one-call answer to "is my VPS healthy right now?" — computed from safe local operating-system evidence, with no shell, SSH or network access for the AI.

## What it answers

Whether the machine running the MCP server currently shows memory or load pressure. It is a whole-host verdict based on operating-system numbers, not an application or service diagnosis.

## Tool

`engineering.vps.health`

## Example question

- "Is my VPS healthy right now?"
- "Is the server under memory pressure at the moment?"

## What it uses

Only local, safe system evidence collected via Node.js `os` APIs inside the server process (source label `local-node-os`): uptime, CPU count, 1-minute load average, total and free memory. No shell, no SSH, no network probes, no files, no credentials.

## Example result

Illustrative, matching the real output contract (`status`, `summary`, `evidence`):

```json
{
  "status": "DEGRADED",
  "summary": "DEGRADED: memory 94.2% used (threshold: > 90%).",
  "evidence": {
    "uptimeSeconds": 387120,
    "cpuCount": 2,
    "loadAverage1m": 0.42,
    "memoryTotalBytes": 4127194112,
    "memoryFreeBytes": 239075328,
    "memoryUsedPercent": 94.2
  }
}
```

## How to interpret it

- `HEALTHY` — memory usage and 1-minute load per CPU are below the documented thresholds.
- `DEGRADED` — clear pressure: memory usage above 90%, or 1-minute load above 2× the CPU count.
- `UNKNOWN` — essential evidence could not be obtained; nothing is invented.

The `evidence` object always carries the raw numbers behind the verdict, so you can check the reasoning yourself.

## Safety model

Read-only and advisory. The tool triggers nothing and has no authority beyond observing: no shell, no SSH, no network, no filesystem, no Docker socket, no credentials, no LLM, no mutation. Input is strictly `{}` — the agent cannot select a host, path or metric.

## Limitations

This is host-level evidence only. It does not observe your application, services, containers, deployments or logs, and it cannot explain why memory is high — see [vps-why-down](vps-why-down.md) for signal synthesis and [logs-explain](logs-explain.md) for log signal explanations.

## Related tools

- [vps-capacity](vps-capacity.md) — the per-component capacity view behind this verdict.
- [vps-incident-summary](vps-incident-summary.md) — compact composition of health, capacity and change observation.
- [vps-why-down](vps-why-down.md) — "why does it look unhealthy?" across all configured evidence.
