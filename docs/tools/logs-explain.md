# Logs Explain

Explain normalized server log signals without giving the AI unrestricted access to your logs — a fixed deterministic taxonomy, not a log browser and not an AI log reader.

## What it answers

"What do the currently configured operational log signals mean?" — each pre-normalized signal (such as `ECONNREFUSED` or `OOM_KILLED`) is mapped to a fixed explanation category with a plain-language meaning and an advisory next check.

## Tool

`engineering.logs.explain`

## Example questions

- "What do these error signals from my server mean?"
- "My monitoring reported OOM_KILLED and ECONNREFUSED — what are those telling me?"

## What it uses

One operator-controlled structured JSON log-evidence file configured via `MEMORYOS_VPS_GUARDIAN_LOG_EVIDENCE_FILE` — already-normalized, already-sanitized log signals produced by the operator's own monitoring stack outside this process (bounded count and string lengths, strict schema). The variable is read once at server startup; the AI can never select the path, file, container, journal, query, filter or time range.

**It is NOT a log browser**: no raw log files, no tail, no watch, no directories, no grep, no journalctl, no docker logs, no Docker socket, no shell, no SSH, no child processes, no network.

## Example result

Illustrative, matching the real output contract:

```json
{
  "status": "EXPLAINED",
  "summary": "EXPLAINED: 2 log signal(s) were mapped to 2 deterministic categories.",
  "source": "operator-log-evidence",
  "observedAt": "2026-09-02T12:00:00Z",
  "evidenceAgeSeconds": 10,
  "explanations": [
    { "category": "OUT_OF_MEMORY", "severity": "ERROR", "meaning": "... fixed meaning ...", "suggestedCheck": "Verify the memory limits of the affected service and look for pressure in your capacity monitoring." },
    { "category": "CONNECTION_REFUSED", "severity": "ERROR", "meaning": "... fixed meaning ...", "suggestedCheck": "Review whether the target service is running and listening on the expected port." }
  ],
  "limitations": ["... fixed deterministic list ..."]
}
```

## How to interpret it

Fixed categories, exactly as implemented: `OUT_OF_MEMORY`, `CONNECTION_REFUSED`, `TIMEOUT`, `PORT_BIND_FAILURE`, `DNS_FAILURE`, `HEALTHCHECK_FAILURE`, `PROCESS_EXIT`, `PERMISSION_FAILURE`.

- Producer-supplied structured codes are matched first; fixed message rules are used only when no code matches.
- `EXPLAINED` — at least one signal maps to a known category.
- `UNKNOWN` — the valid evidence contains no entries or every entry is unclassifiable; unknown signals are never guessed.
- `UNAVAILABLE` — no evidence source is configured, or it returned no valid evidence.

`suggestedCheck` is advisory prose only — no executable commands are ever emitted.

## Safety model

Raw evidence messages are never returned: explanations carry only the category, highest observed severity, a fixed meaning and the advisory check. Deterministic and LLM-free — no AI analysis of your logs. Read-only, fail-closed parsing, input strictly `{}`.

## Limitations

This is not general-purpose log understanding: signals outside the fixed taxonomy are reported as UNKNOWN by design. Statuses describe explanations, not health — absence of a signal does not mean absence of a problem.

## Related tools

- [docker-health](docker-health.md) — aggregate container verdicts that pair well with healthcheck/exit signals.
- [vps-why-down](vps-why-down.md) — cross-evidence signal synthesis.
- [vps-incident-summary](vps-incident-summary.md) — quick current-state composition.
