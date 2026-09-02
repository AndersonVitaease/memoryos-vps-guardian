# Application Health

Answers "what application health state is reported?" from the operator-controlled release-state evidence — without the AI probing your HTTP endpoints.

## What it answers

Whether the operator's own monitoring stack currently reports the configured application as healthy. The tool reports evidence; it never generates health itself.

## Tool

`engineering.app.health`

## Example questions

- "Is my application healthy according to the evidence?"
- "Is the app reporting healthy right now?"

## What it uses

The same operator-configured release-state evidence source as [deploy-status](deploy-status.md) (`MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE`). No new environment variable, transport or adapter exists, and the agent can never supply the path or any evidence value.

## Example result

Illustrative, matching the real output contract:

```json
{
  "status": "DEGRADED",
  "summary": "DEGRADED: the configured evidence source reports the application as not healthy.",
  "applicationId": "my-app",
  "source": "operator-release-state",
  "observedAt": "2026-09-02T12:00:00Z",
  "evidenceAgeSeconds": 90,
  "limitations": ["... fixed deterministic list ..."]
}
```

## How to interpret it

- `HEALTHY` — the source reports `applicationHealthy: true`.
- `DEGRADED` — the source reports `applicationHealthy: false`.
- `UNKNOWN` — a valid source explicitly reported no application health.
- `UNAVAILABLE` — no source is configured, or it returned no valid evidence.

**Application health ≠ deployment status.** The two tools consume the same evidence but answer different questions through different classifiers and are never reconciled: `deploymentStatus=SUCCEEDED` with `applicationHealthy=false` truthfully yields `OK` from [deploy-status](deploy-status.md) and `DEGRADED` from this tool.

## Safety model

Read-only and advisory. The tool does NOT probe the application, inspect Docker, call HTTP, infer health from the deployment status, or diagnose a root cause. No shell, no SSH, no network, no filesystem access beyond the one fixed evidence file, no credentials, no mutation. Input is strictly `{}`.

## Limitations

UNAVAILABLE means no valid observation exists; UNKNOWN means a valid observation exists but the source explicitly did not report application health. The evidence is only as fresh and honest as the operator's monitoring stack that produces the file; `evidenceAgeSeconds` is shown so you can judge that yourself.

## Related tools

- [deploy-status](deploy-status.md) — the deployment-state answer from the same source.
- [deploy-ready](deploy-ready.md) — uses application health as one prerequisite component.
- [docker-health](docker-health.md) — container-side evidence from its own source.
