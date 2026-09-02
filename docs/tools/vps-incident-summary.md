# Incident Summary

One compact answer to "what is happening on my VPS right now?" — a deterministic composition of available system evidence, never a root-cause analysis.

## What it answers

Whether the currently available evidence shows a condition that needs attention, with one factual note per observed component. It is a synthesis of existing evidence, not a new source, and it never names a cause.

## Tool

`engineering.vps.incident.summary`

## Example questions

- "What is happening with my VPS right now?"
- "Give me a quick status rundown of the server."

## What it uses

Exactly the evidence already available to the server: the local health verdict ([vps-health](vps-health.md)), the capacity assessment ([vps-capacity](vps-capacity.md)) and the session-scoped change observation ([vps-what-changed](vps-what-changed.md)). No new collection, no network, no shell.

## Example result

Illustrative, matching the real output contract (`status`, `summary`, `observations`, `limitations`):

```json
{
  "status": "ATTENTION",
  "summary": "ATTENTION: 1 observed condition(s) currently require attention.",
  "observations": [
    { "source": "engineering.vps.health", "status": "DEGRADED", "note": "memory 94.2% used (threshold: > 90%)." },
    { "source": "engineering.vps.capacity", "status": "OK", "note": "no CPU or memory capacity pressure beyond thresholds." },
    { "source": "engineering.vps.what_changed", "status": "NO_CHANGE", "note": "no significant change since the previous observation." }
  ],
  "limitations": ["... fixed deterministic list ..."]
}
```

## How to interpret it

- `NORMAL` — health HEALTHY, capacity OK and no significant change observed (a freshly created change baseline is never treated as an incident or as proof of past stability).
- `ATTENTION` — one or more currently observed conditions require attention: health DEGRADED, capacity PRESSURED or a significant change. This is not a confirmed incident, outage or failure.
- `UNKNOWN` — some required evidence was unavailable or inconsistent; absence of evidence is never reported as NORMAL or ATTENTION.

`observations` contains exactly one factual note per component. The fixed `limitations` list states that no causal conclusion is made and that applications, services, containers, deployments and logs are not observed.

## Safety model

Read-only and advisory: it triggers nothing and names no cause. Input is strictly `{}`. Calling it counts as one shared change observation — direct `what_changed` calls and summary calls advance the same session-scoped sequence.

## Limitations

Evidence gaps are explicit: if a component cannot be observed, the verdict is UNKNOWN, never NORMAL. It cannot see applications, containers, deployments or logs; use [app-health](app-health.md), [docker-health](docker-health.md) and [logs-explain](logs-explain.md) for those domains.

## Related tools

- [vps-health](vps-health.md) and [vps-capacity](vps-capacity.md) — the components it composes.
- [vps-what-changed](vps-what-changed.md) — the change observation it includes.
- [vps-why-down](vps-why-down.md) — broader signal synthesis when something does look wrong.
