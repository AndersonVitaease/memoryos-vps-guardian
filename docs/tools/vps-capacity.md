# VPS Capacity

Answers "is my VPS close to its limits?" with a per-component CPU and memory pressure view — safe local evidence, no SSH, no monitoring agents to install.

## What it answers

Whether current resource usage is approaching capacity limits, broken down per component (CPU and memory) with a global verdict. This is capacity evidence, not application diagnosis: high memory tells you the host is pressured, not which process is responsible.

## Tool

`engineering.vps.capacity`

## Example questions

- "Is my VPS close to its limits?"
- "Am I running out of memory or CPU headroom?"

## What it uses

Local operating-system evidence via Node.js `os` APIs (source label `local-node-os`): CPU count, 1-minute load average, total and free memory. No shell, no SSH, no network, no filesystem, no credentials.

## Example result

Illustrative, matching the real output contract (`status`, `summary`, `capacity`):

```json
{
  "status": "OK",
  "summary": "OK: cpu OK (load 0 per CPU, threshold 2); memory OK (43.1% used, threshold 90%)",
  "capacity": {
    "cpu": { "cpuCount": 2, "loadAverage1m": 0.1, "loadPerCpu": 0.05, "pressure": "OK" },
    "memory": { "totalBytes": 4127194112, "freeBytes": 2347167744, "usedPercent": 43.1, "pressure": "OK" }
  }
}
```

## How to interpret it

- `OK` — both CPU load and memory usage are below the documented thresholds.
- `PRESSURED` — one or both components are under clear pressure.
- `UNKNOWN` — essential evidence could not be obtained; nothing is invented.

Per-component thresholds: memory used > 90% → `HIGH`; 1-minute load / CPU count > 2 → `HIGH`. The result is a present-tense snapshot — no future prediction and no automatic upgrade recommendation.

## Safety model

Read-only and advisory: the tool triggers nothing, recommends nothing automatically and has no write, network or process authority. Input is strictly `{}` — the agent cannot select a host, path or metric.

## Limitations

This observes host capacity only. It cannot attribute pressure to a process, predict disk exhaustion, or tell you whether an application is healthy — combine it with [app-health](app-health.md) or [logs-explain](logs-explain.md) when you need application-side context.

## Related tools

- [vps-health](vps-health.md) — the overall host verdict built on the same evidence.
- [deploy-ready](deploy-ready.md) — uses capacity as one prerequisite component.
- [vps-incident-summary](vps-incident-summary.md) — one-call composition including capacity.
