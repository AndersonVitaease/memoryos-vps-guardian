# Deploy Ready

An advisory answer to "are the minimum deterministic deployment prerequisites currently met?" — a pre-flight checklist over available evidence, never a permission slip.

## What it answers

Whether the currently configured, validated evidence indicates that minimum prerequisites for attempting a deployment are met right now: no deployment in flight or queued, application reported healthy, VPS not degraded, capacity not pressured.

## Tool

`engineering.deploy.ready`

## Example questions

- "Is it safe to deploy right now?"
- "Are the deployment prerequisites currently met?"

## What it uses

Only evidence already available to the server, through the same certified classifiers as the source tools: the operator-configured release-state evidence (deployment status + application health, `MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE`) and the local VPS health/capacity evidence. Four normalized components are reported. No new configuration, no new privileged access, no tool-to-tool calls.

## Example result

Illustrative, matching the real output contract:

```json
{
  "status": "NOT_READY",
  "summary": "NOT_READY: 1 blocking condition observed.",
  "applicationId": "my-app",
  "components": {
    "deployment": "OK",
    "applicationHealth": "DEGRADED",
    "vpsHealth": "HEALTHY",
    "vpsCapacity": "OK"
  },
  "reasons": ["application health is reported as degraded."],
  "evidenceAgeSeconds": 90,
  "limitations": ["... fixed deterministic list ..."]
}
```

## How to interpret it

- `READY` — all required components currently satisfy the minimum deterministic prerequisites.
- `NOT_READY` — at least one factual, non-causal blocking reason exists (listed in `reasons`).
- `UNKNOWN` — required valid evidence is incomplete; absence of evidence is never read as READY.
- `UNAVAILABLE` — a required evidence source is unavailable.

## Safety model

Strictly advisory: this tool deploys nothing, approves nothing and grants no deployment or recovery authority. It does not predict deployment success and does not inspect code, migrations or release contents. Read-only, deterministic, input strictly `{}`.

## Limitations

READY does not guarantee a successful deployment — it is a checklist over available evidence, not a prediction. UNKNOWN-first: any required component without evidence yields UNKNOWN, never READY or NOT_READY.

## Related tools

- [deploy-status](deploy-status.md) — the deployment-state component.
- [app-health](app-health.md) — the application-health component.
- [vps-capacity](vps-capacity.md) — the capacity component.
