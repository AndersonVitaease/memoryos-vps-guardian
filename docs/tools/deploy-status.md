# Deploy Status

Answers "is my deployment working?" from one operator-controlled release-state evidence file — without giving the AI shell access, SSH or deployment authority.

## What it answers

What deployment state the operator's own monitoring stack currently reports for the configured application: succeeded, in progress, queued or failed — plus when it was observed.

## Tool

`engineering.deploy.status`

## Example questions

- "Is my deployment working?"
- "Did the last deployment finish successfully?"

## What it uses

One operator-fixed structured JSON file configured via the `MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE` environment variable (the release-state evidence format: application id, observed time, source label, current release id, deployment status and related fields). The variable is read once at server startup by the host process — never supplied, selected or changed by the AI, and no tool argument carries evidence.

## Example result

Illustrative, matching the real output contract:

```json
{
  "status": "OK",
  "summary": "OK: the configured evidence source reports a succeeded deployment.",
  "applicationId": "my-app",
  "source": "operator-release-state",
  "observedAt": "2026-09-02T12:00:00Z",
  "currentReleaseId": "release-42",
  "lastDeploymentFinishedAt": "2026-09-02T11:58:30Z",
  "evidenceAgeSeconds": 90,
  "limitations": ["... fixed deterministic list ..."]
}
```

## How to interpret it

- `OK` — the source reports a succeeded deployment.
- `IN_FLIGHT` / `PENDING` — a deployment is reported in progress or queued.
- `FAILED` — the source reports a failed deployment.
- `UNKNOWN` — a valid source explicitly reported no deployment status.
- `UNAVAILABLE` — no source is configured, or it returned no valid evidence.

`evidenceAgeSeconds` is the factual age of the evidence and never changes the verdict; a negative value means observable clock skew. With no valid evidence, all evidence-derived fields are `null` — nothing is invented.

## Safety model

Read-only and advisory: it reports state and triggers nothing. The file path is operator-controlled and fixed at startup; the AI can never point the tool at another file, and the path, file contents and validation errors are never exposed. Evidence is strictly schema-validated and fail-closed.

## Limitations

This tool does not assess application health, VPS health, readiness to deploy, rollback suitability, failure root cause or change safety. Zero-configuration behavior: without the environment variable the tool stays registered and truthfully answers UNAVAILABLE.

## Related tools

- [app-health](app-health.md) — the application-health answer from the same evidence source.
- [deploy-ready](deploy-ready.md) — advisory readiness prerequisites across evidence sources.
- [vps-why-down](vps-why-down.md) — synthesis that includes the deployment signal.
