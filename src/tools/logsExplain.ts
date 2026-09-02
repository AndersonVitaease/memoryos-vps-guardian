/**
 * engineering.logs.explain (Tool 10, public MVP).
 *
 * Public question answered (ONLY this): "What do the currently configured
 * operational log signals mean?" — a deterministic, read-only, advisory
 * explanation computed ONLY from the operator-configured log-evidence source
 * (a fixed operator-controlled JSON file produced outside this process; see
 * adapters/logEvidenceFile.ts). This tool is NOT a log browser, grep, shell
 * wrapper, journalctl wrapper, docker-logs wrapper or AI chatbot: no log
 * reading, no tail, no watch, no directory access, no shell, no SSH, no
 * child_process, no network, no LLM, no mutation. Input must be exactly {} —
 * the agent can never select a path, file, container, service, journal,
 * query, filter or time range.
 *
 * Classification is a pure deterministic function of the evidence (see
 * assessLogsExplain): a small explicit taxonomy matched first from
 * producer-supplied structured codes, then (only when no code is present)
 * from a small fixed set of message rules. Unclassifiable signals are
 * reported as UNKNOWN and never guessed. Evidence messages are NEVER
 * returned: only category, severity, a fixed meaning and an advisory
 * plain-language suggested check.
 */
import { z } from "zod";
import { assertStrictEmptyInput } from "./vpsHealth";
import type {
  LogEvidence,
  LogEvidenceAdapter,
  LogEvidenceEntry,
  LogEvidenceSeverity,
} from "../adapters/logEvidence";

export type LogsExplainStatus = "EXPLAINED" | "UNKNOWN" | "UNAVAILABLE";

export type LogSignalCategory =
  | "OUT_OF_MEMORY"
  | "CONNECTION_REFUSED"
  | "TIMEOUT"
  | "PORT_BIND_FAILURE"
  | "DNS_FAILURE"
  | "HEALTHCHECK_FAILURE"
  | "PROCESS_EXIT"
  | "PERMISSION_FAILURE"
  | "UNKNOWN";

export interface LogsExplanation {
  category: LogSignalCategory;
  severity: LogEvidenceSeverity;
  meaning: string;
  suggestedCheck: string;
}

export interface LogsExplainToolResult {
  status: LogsExplainStatus;
  summary: string;
  source: string | null;
  observedAt: string | null;
  evidenceAgeSeconds: number | null;
  explanations: LogsExplanation[];
  limitations: string[];
}

export const logsExplainOutputSchema = z.object({
  status: z.enum(["EXPLAINED", "UNKNOWN", "UNAVAILABLE"]),
  summary: z.string(),
  source: z.string().nullable(),
  observedAt: z.string().nullable(),
  evidenceAgeSeconds: z.number().int().nullable(),
  explanations: z.array(
    z.object({
      category: z.enum([
        "OUT_OF_MEMORY",
        "CONNECTION_REFUSED",
        "TIMEOUT",
        "PORT_BIND_FAILURE",
        "DNS_FAILURE",
        "HEALTHCHECK_FAILURE",
        "PROCESS_EXIT",
        "PERMISSION_FAILURE",
        "UNKNOWN",
      ]),
      severity: z.enum(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]),
      meaning: z.string(),
      suggestedCheck: z.string(),
    }),
  ),
  limitations: z.array(z.string()),
});

export const LOGS_EXPLAIN_LIMITATIONS: string[] = [
  "Read-only and advisory: this tool explains nothing beyond the operator-configured log evidence source and deploys, restarts and repairs nothing.",
  "It never reads raw logs: no log files, streams, directories, journals or container logs — the only evidence is the one operator-fixed structured JSON file configured at startup (MEMORYOS_VPS_GUARDIAN_LOG_EVIDENCE_FILE), when present, valid and within the size bound.",
  "Explanations are deterministic matches over normalized producer-supplied codes plus a small fixed message rule set — no AI analysis; unclassified signals are reported as UNKNOWN and never guessed.",
  "Raw evidence messages are never returned: only category, severity, a fixed meaning and an advisory plain-language suggested check are reported.",
  "Absence of a signal here does not mean absence of a problem: an unconfigured or unreadable source is reported as UNAVAILABLE and is never read as healthy.",
];

const NO_ADAPTER_SUMMARY =
  "UNAVAILABLE: no log evidence source is configured for this server, so no log signals could be explained; nothing is inferred.";
const EVIDENCE_FAILURE_SUMMARY =
  "UNAVAILABLE: the configured log evidence source returned no valid evidence for this call; nothing is inferred.";

/**
 * Exact producer-supplied code map (matched case-insensitively after
 * uppercasing). Structured codes are the PREFERRED classification input.
 */
const CODE_TO_CATEGORY: Readonly<Record<string, LogSignalCategory>> = {
  OOM: "OUT_OF_MEMORY",
  OUT_OF_MEMORY: "OUT_OF_MEMORY",
  OOM_KILLED: "OUT_OF_MEMORY",
  ENOMEM: "OUT_OF_MEMORY",
  ECONNREFUSED: "CONNECTION_REFUSED",
  CONNECTION_REFUSED: "CONNECTION_REFUSED",
  ETIMEDOUT: "TIMEOUT",
  TIMEOUT: "TIMEOUT",
  TIMED_OUT: "TIMEOUT",
  EADDRINUSE: "PORT_BIND_FAILURE",
  ADDRESS_IN_USE: "PORT_BIND_FAILURE",
  PORT_BIND_FAILURE: "PORT_BIND_FAILURE",
  ENOTFOUND: "DNS_FAILURE",
  EAI_AGAIN: "DNS_FAILURE",
  DNS_FAILURE: "DNS_FAILURE",
  HEALTHCHECK_FAILED: "HEALTHCHECK_FAILURE",
  HEALTHCHECK_FAILURE: "HEALTHCHECK_FAILURE",
  UNHEALTHY: "HEALTHCHECK_FAILURE",
  PROCESS_EXIT: "PROCESS_EXIT",
  CRASHED: "PROCESS_EXIT",
  EXITED: "PROCESS_EXIT",
  EACCES: "PERMISSION_FAILURE",
  EPERM: "PERMISSION_FAILURE",
  PERMISSION_DENIED: "PERMISSION_FAILURE",
};

/**
 * Small fixed message rules, applied ONLY when the entry carries no
 * recognizable code. Fixed order = deterministic first match; TIMEOUT rules
 * are deliberately last because "timeout" is the most generic token and often
 * co-occurs with more specific causes.
 */
const MESSAGE_RULES: ReadonlyArray<{ category: LogSignalCategory; pattern: RegExp }> = [
  { category: "OUT_OF_MEMORY", pattern: /\bout of memory\b/i },
  { category: "OUT_OF_MEMORY", pattern: /\boom\b/i },
  { category: "CONNECTION_REFUSED", pattern: /\bconnection refused\b/i },
  { category: "PORT_BIND_FAILURE", pattern: /\baddress already in use\b/i },
  { category: "DNS_FAILURE", pattern: /\bgetaddrinfo\b/i },
  { category: "DNS_FAILURE", pattern: /\bname or service not known\b/i },
  { category: "DNS_FAILURE", pattern: /\btemporary failure in name resolution\b/i },
  { category: "PERMISSION_FAILURE", pattern: /\bpermission denied\b/i },
  { category: "HEALTHCHECK_FAILURE", pattern: /\bhealth ?check\b/i },
  { category: "PROCESS_EXIT", pattern: /\bprocess exited\b/i },
  { category: "PROCESS_EXIT", pattern: /\bexited with\b/i },
  { category: "PROCESS_EXIT", pattern: /\bexit code\b/i },
  { category: "TIMEOUT", pattern: /\btimed out\b/i },
  { category: "TIMEOUT", pattern: /\btimeout\b/i },
];

const SEVERITY_ORDER: Readonly<Record<LogEvidenceSeverity, number>> = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4,
};

const CATEGORY_MEANING: Readonly<Record<LogSignalCategory, string>> = {
  OUT_OF_MEMORY: "The evidence reports an out-of-memory signal: the affected process or component likely exhausted available memory.",
  CONNECTION_REFUSED: "The evidence reports a connection-refused signal: something attempted to reach a service that was not accepting connections.",
  TIMEOUT: "The evidence reports a timeout signal: an operation did not complete within its allowed time budget.",
  PORT_BIND_FAILURE: "The evidence reports a port-bind failure: a process could not bind the network port it needs (it may already be in use).",
  DNS_FAILURE: "The evidence reports a DNS/name-resolution failure: a hostname could not be resolved.",
  HEALTHCHECK_FAILURE: "The evidence reports a health-check failure: a configured health check reported the affected component as not healthy.",
  PROCESS_EXIT: "The evidence reports a process-exit signal: a monitored process ended, possibly unexpectedly.",
  PERMISSION_FAILURE: "The evidence reports a permission failure: an operation was denied due to insufficient permissions.",
  UNKNOWN: "This log signal could not be mapped to any known deterministic category; no inference is made.",
};

const CATEGORY_SUGGESTED_CHECK: Readonly<Record<LogSignalCategory, string>> = {
  OUT_OF_MEMORY: "Verify the memory usage and limits of the affected process or component around the time of this signal.",
  CONNECTION_REFUSED: "Verify whether the target service was running and listening on the address and port that was attempted.",
  TIMEOUT: "Verify whether the target operation or dependency was slow or unreachable and whether its timeout budget was adequate.",
  PORT_BIND_FAILURE: "Verify whether another process already holds the configured port and whether the affected process may bind it.",
  DNS_FAILURE: "Verify the DNS resolver configuration and whether the hostname resolves from this host.",
  HEALTHCHECK_FAILURE: "Verify the health-check definition and the state of the component it probes.",
  PROCESS_EXIT: "Verify the process exit status in the operator-side monitoring and whether the exit was expected.",
  PERMISSION_FAILURE: "Verify the permissions of the account running the affected process on the file, port or resource involved.",
  UNKNOWN: "Review this signal in the operator-side log evidence source, outside this tool, for full context.",
};

/**
 * Deterministic classification of ONE normalized entry:
 * 1. structured code (uppercased exact map lookup) — preferred;
 * 2. otherwise the small fixed message rule set (first match in fixed order);
 * 3. otherwise UNKNOWN. Never throws, never guesses beyond the tables above.
 */
function classifyEntry(entry: LogEvidenceEntry): LogSignalCategory {
  if (entry.code !== null) {
    const mapped = CODE_TO_CATEGORY[entry.code.toUpperCase()];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  if (entry.message !== null) {
    for (const rule of MESSAGE_RULES) {
      if (rule.pattern.test(entry.message)) {
        return rule.category;
      }
    }
  }
  return "UNKNOWN";
}

/**
 * Certified-style pure deterministic classifier for logs.explain.
 *
 * Status semantics (exact, small):
 * - UNKNOWN: valid evidence document but zero entries, or every entry
 *   unclassifiable — no explanation is invented.
 * - EXPLAINED: at least one entry mapped to a known category. Explanations
 *   are grouped per category (first-occurrence order, UNKNOWN last) and each
 *   carries the HIGHEST severity observed for that category.
 * - UNAVAILABLE is decided by the handler (no adapter / null evidence).
 */
export function assessLogsExplain(
  evidence: LogEvidence,
): Omit<LogsExplainToolResult, "limitations"> {
  const order: LogSignalCategory[] = [];
  const highest = new Map<LogSignalCategory, LogEvidenceSeverity>();
  let knownCount = 0;
  let unclassifiedCount = 0;

  for (const entry of evidence.entries) {
    const category = classifyEntry(entry);
    if (!highest.has(category)) {
      order.push(category);
      highest.set(category, entry.severity);
    } else if (SEVERITY_ORDER[entry.severity] > SEVERITY_ORDER[highest.get(category) as LogEvidenceSeverity]) {
      highest.set(category, entry.severity);
    }
    if (category === "UNKNOWN") {
      unclassifiedCount += 1;
    } else {
      knownCount += 1;
    }
  }

  const provenance = {
    source: evidence.source,
    observedAt: evidence.observedAt,
    evidenceAgeSeconds: null,
  };

  if (evidence.entries.length === 0) {
    return {
      status: "UNKNOWN",
      summary:
        "UNKNOWN: the configured log evidence source provided a valid document with no log signal entries; nothing is inferred.",
      explanations: [],
      ...provenance,
    };
  }

  const explanations: LogsExplanation[] = order.map((category) => ({
    category,
    severity: highest.get(category) as LogEvidenceSeverity,
    meaning: CATEGORY_MEANING[category],
    suggestedCheck: CATEGORY_SUGGESTED_CHECK[category],
  }));

  if (knownCount === 0) {
    return {
      status: "UNKNOWN",
      summary: `UNKNOWN: ${unclassifiedCount} log signal(s) could not be mapped to any known deterministic category; no inference is made.`,
      explanations,
      ...provenance,
    };
  }

  const knownCategories = order.filter((category) => category !== "UNKNOWN");
  const knownNoun = knownCategories.length === 1 ? "category" : "categories";
  const summary =
    unclassifiedCount === 0
      ? `EXPLAINED: ${knownCount} log signal(s) were mapped to ${knownCategories.length} deterministic ${knownNoun} (${knownCategories.join(", ")}).`
      : `EXPLAINED: ${knownCount} log signal(s) were mapped to ${knownCategories.length} deterministic ${knownNoun} (${knownCategories.join(", ")}); ${unclassifiedCount} additional signal(s) are reported as UNKNOWN.`;

  return {
    status: "EXPLAINED",
    summary,
    explanations,
    ...provenance,
  };
}

/**
 * Tool handler. Clock semantics identical to app.health/deploy.ready/
 * docker.health: nowMs() is called exactly once and only when valid evidence
 * exists; on every UNAVAILABLE branch it is never called.
 */
export function handleLogsExplain(
  input: unknown,
  logEvidenceAdapter: LogEvidenceAdapter | null | undefined,
  nowMs: () => number = Date.now,
): LogsExplainToolResult {
  assertStrictEmptyInput(input);

  if (logEvidenceAdapter === null || logEvidenceAdapter === undefined) {
    return {
      status: "UNAVAILABLE",
      summary: NO_ADAPTER_SUMMARY,
      source: null,
      observedAt: null,
      evidenceAgeSeconds: null,
      explanations: [],
      limitations: LOGS_EXPLAIN_LIMITATIONS,
    };
  }

  const evidence = logEvidenceAdapter.collect();
  if (evidence === null) {
    return {
      status: "UNAVAILABLE",
      summary: EVIDENCE_FAILURE_SUMMARY,
      source: null,
      observedAt: null,
      evidenceAgeSeconds: null,
      explanations: [],
      limitations: LOGS_EXPLAIN_LIMITATIONS,
    };
  }

  const now = nowMs();
  const assessed = assessLogsExplain(evidence);
  return {
    status: assessed.status,
    summary: assessed.summary,
    source: assessed.source,
    observedAt: assessed.observedAt,
    evidenceAgeSeconds: Math.floor((now - Date.parse(evidence.observedAt)) / 1000),
    explanations: assessed.explanations,
    limitations: LOGS_EXPLAIN_LIMITATIONS,
  };
}
