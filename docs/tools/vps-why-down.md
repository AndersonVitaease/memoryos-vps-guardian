# Why Down

Ask your AI why your VPS appears unhealthy — without pretending correlation is causation. A deterministic synthesis of every configured operational signal, with no invented root cause.

## What it answers

"Is there evidence of a problem, which concrete signals are observed, and what cannot be determined?" — across all evidence sources configured on the server.

## Tool

`engineering.vps.why_down`

## Example questions

- "Why is my VPS having a problem?"
- "What signals do you see that could explain the unhealthy state?"

## What it uses

Only evidence already available to this server: one local system-health snapshot feeds the existing VPS health and capacity classifiers, and — when configured — the operator-controlled release-state and docker-health evidence files feed the application health, deployment status and Docker classifiers directly (no tool-to-tool calls, no new evidence transport).

## Example result

Illustrative, matching the real output contract (`status`, `summary`, `signals`, `limitations`):

```json
{
  "status": "DEGRADED",
  "summary": "DEGRADED: 2 problem signal(s) observed. This is an observed correlation, not a causal diagnosis.",
  "signals": [
    { "category": "APPLICATION_HEALTH", "source": "operator-release-state", "status": "DEGRADED", "summary": "the evidence source reports the application as not healthy." },
    { "category": "DOCKER", "source": "operator-docker-health", "status": "DEGRADED", "summary": "1 container(s) reported unhealthy." }
  ],
  "limitations": ["... fixed deterministic list ..."]
}
```

## How to interpret it

Signal categories, exactly as implemented: `VPS_HEALTH`, `CAPACITY`, `APPLICATION_HEALTH`, `DEPLOYMENT`, `DOCKER`.

- `DEGRADED` — at least one factual problem signal: health degraded, capacity pressured, application degraded, deployment FAILED, or Docker degraded. All problem signals remain visible; none is chosen as the cause.
- `UNKNOWN` — any observed signal is incomplete, inconsistent or unavailable; missing evidence is never turned into a failure story.
- `HEALTHY` — all observed signals report no problem condition.
- `UNAVAILABLE` — no evidence source is configured at all.

A deployment IN_FLIGHT or PENDING is reported factually and is not a problem signal. Categories without a configured source are absent from `signals` and are never read as healthy.

## Safety model

Signals are observations, not causes: there is no root-cause field, and the summary explicitly states that correlation is not causation. Read-only and advisory: no shell, no SSH, no network probe, no Docker socket, no child processes, no log access. Input is strictly `{}`.

## Limitations

The tool explains available operational signals; it does not invent a singular cause. Zero-configuration: without the optional evidence files it answers from local VPS health and capacity alone, with the missing categories explicit in the limitations.

## Related tools

- [docker-health](docker-health.md) — the Docker signal source.
- [logs-explain](logs-explain.md) — explains concrete log signals such as OOM or connection refused.
- [vps-health](vps-health.md) and [deploy-status](deploy-status.md) — the underlying local and deployment evidence.
