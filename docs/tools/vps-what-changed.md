# What Changed

A session-scoped diff of observable system state: "what changed since the previous observation made by this MCP process?" — deliberately honest about what it cannot know.

## What it answers

Which of the locally observed host metrics changed since the previous observation of the running MCP server process — CPU count changes, reboots (uptime decreases), significant memory shifts and significant load shifts.

## Tool

`engineering.vps.what_changed`

## Example questions

- "What changed since you last looked?"
- "Did the server reboot since the baseline was created?"

## What it uses

Local operating-system evidence via Node.js `os` APIs (source label `local-node-os`). The baseline and history live only in the memory of the running MCP server process.

## Example result

Illustrative, matching the real output contract (`status`, `summary`, `baselineCapturedAt`, `observationsSinceBaseline`, `changes`):

```json
{
  "status": "CHANGED",
  "summary": "CHANGED: 1 significant change since the previous observation.",
  "baselineCapturedAt": "2026-09-02T12:00:00Z",
  "observationsSinceBaseline": 4,
  "changes": [
    { "category": "memory", "description": "free memory changed by more than 1% of total memory", "before": 2347167744, "after": 512000000 }
  ]
}
```

## How to interpret it

- `BASELINE_CREATED` — first observation of this process; nothing could be compared yet.
- `CHANGED` — one or more differences above the documented thresholds since the previous observation of this process.
- `NO_CHANGE` — nothing changed above the thresholds between observations of this process. This does not mean nothing changed on the VPS outside the observed evidence.
- `UNKNOWN` — evidence was unavailable or inconsistent; nothing is fabricated.

Change categories, exactly as implemented: `cpuCount` (CPU count differs), `reboot` (uptime decreased — factual only, no cause claimed), `memory` (free memory moved by more than 1% of total), `cpu` (load per CPU moved by more than 0.5).

## Safety model

Read-only and advisory. It keeps state only in process memory, writes nothing to disk, and never infers events it did not observe. Input is strictly `{}`.

## Limitations

**Session scope matters.** Restarting the MCP server resets all history; there is no visibility into anything before the baseline. This is not Git history, not deployment history, not service/file/configuration history — it compares only the host metrics listed above, across consecutive observations of this process.

## Related tools

- [vps-incident-summary](vps-incident-summary.md) — includes one change observation per call (shared history).
- [vps-health](vps-health.md) — the current host verdict.
- [deploy-status](deploy-status.md) — deployment facts from the operator-configured evidence source.
