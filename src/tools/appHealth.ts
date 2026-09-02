/**
 * engineering.app.health — public MVP tool (read-only, deterministic).
 *
 * Contract:
 * - Answers ONLY: "What application health state is reported by the
 *   configured validated application/deployment evidence source?" It does
 *   NOT probe the application, inspect Docker, call HTTP, infer health from
 *   deploymentStatus or VPS metrics, or diagnose a root cause.
 * - Input must be exactly {} (no parameters), enforced at the tool boundary
 *   (assertStrictEmptyInput) and at the MCP protocol layer
 *   (z.object({}).strict() -> additionalProperties: false).
 * - Evidence chain: the injected ApplicationDeploymentAdapter -> collect() ->
 *   validated ApplicationDeploymentEvidence -> the certified
 *   assessApplicationHealth() classifier. Health classification is NOT
 *   duplicated here; no other signal (deploymentStatus, CPU, memory, load,
 *   uptime, git, Docker, network, LLM) is ever used.
 * - No adapter configured, or collect() returning null -> UNAVAILABLE with
 *   all evidence-derived fields null. A valid source reporting
 *   applicationHealthy: null -> UNKNOWN with factual fields preserved.
 *   Never throws for evidence failures and never exposes the configured
 *   path, file contents, filesystem/validation errors or stack traces.
 * - evidenceAgeSeconds is factual presentation only:
 *   floor((nowMs - Date.parse(observedAt)) / 1000). The clock is injectable
 *   for deterministic tests and the age NEVER changes the status. Negative
 *   values are observable clock skew and are preserved, never clamped. No
 *   timer, polling, watch, cache, retry or max-age policy exists anywhere.
 *   05D refinement: the clock is NOT called at all unless valid evidence
 *   exists (zero calls on the UNAVAILABLE branches; exactly one call when a
 *   valid observation is classified).
 * - engineering.app.health and engineering.deploy.status consume the same
 *   evidence but answer different questions through different certified
 *   classifiers; they never reconcile each other. Contradictory evidence
 *   (e.g. deploymentStatus=SUCCEEDED + applicationHealthy=false) remains
 *   independently reportable as-is.
 */
import { z } from "zod";
import { assertStrictEmptyInput } from "./vpsHealth";
import { assessApplicationHealth } from "./applicationDeployment";
import type { ApplicationDeploymentAdapter } from "../adapters/applicationDeployment";

export type AppHealthStatus = "HEALTHY" | "DEGRADED" | "UNKNOWN" | "UNAVAILABLE";

export interface AppHealthToolResult {
  status: AppHealthStatus;
  summary: string;
  applicationId: string | null;
  source: string | null;
  observedAt: string | null;
  evidenceAgeSeconds: number | null;
  limitations: string[];
}

export const appHealthOutputSchema = z.object({
  status: z.enum(["HEALTHY", "DEGRADED", "UNKNOWN", "UNAVAILABLE"]),
  summary: z.string(),
  applicationId: z.string().nullable(),
  source: z.string().nullable(),
  observedAt: z.string().nullable(),
  evidenceAgeSeconds: z.number().int().nullable(),
  limitations: z.array(z.string()),
});

/** Fixed, factual limitations. Verdict-neutral wording; never mentions paths. */
export const APP_HEALTH_LIMITATIONS: string[] = [
  "Read-only and advisory: reports only the application health reported by the configured validated evidence source; this tool probes nothing, diagnoses nothing and triggers nothing.",
  "No inference is made from deploymentStatus, VPS health, CPU, memory, load, uptime, git, Docker, network or any other signal.",
  "evidenceAgeSeconds is factual evidence age only and never changes the status.",
  "UNAVAILABLE means no valid observation exists (no source is configured, or the source returned nothing); UNKNOWN means a valid source answered but did not report applicationHealthy.",
];

const NO_ADAPTER_SUMMARY =
  "UNAVAILABLE: no application/deployment evidence source is configured for this " +
  "server; nothing was inferred.";

const EVIDENCE_FAILURE_SUMMARY =
  "UNAVAILABLE: the configured application/deployment evidence source returned no " +
  "valid evidence for this call; nothing was inferred.";

/**
 * Handle one engineering.app.health call.
 *
 * adapter: the construction-time evidence source, or null/undefined when the
 * operator configured none. nowMs defaults to the invocation-time clock and
 * is injectable for deterministic tests; it is called ONLY when valid
 * evidence exists (exactly once), never on the UNAVAILABLE branches.
 */
export function handleAppHealth(
  input: unknown,
  adapter: ApplicationDeploymentAdapter | null | undefined,
  nowMs: () => number = Date.now,
): AppHealthToolResult {
  assertStrictEmptyInput(input);

  if (adapter === null || adapter === undefined) {
    // No source configured: the clock is never consulted (0 calls).
    return {
      status: "UNAVAILABLE",
      summary: NO_ADAPTER_SUMMARY,
      applicationId: null,
      source: null,
      observedAt: null,
      evidenceAgeSeconds: null,
      limitations: APP_HEALTH_LIMITATIONS,
    };
  }

  const evidence = adapter.collect();
  const classified = assessApplicationHealth(evidence);

  if (evidence === null) {
    // Delivery/validation failure: nothing may be exposed except the fixed
    // truthful reason. The certified classifier already returns UNAVAILABLE
    // with all evidence-derived fields null. The clock is never consulted.
    return {
      status: classified.status,
      summary: EVIDENCE_FAILURE_SUMMARY,
      applicationId: null,
      source: null,
      observedAt: null,
      evidenceAgeSeconds: null,
      limitations: APP_HEALTH_LIMITATIONS,
    };
  }

  // Valid evidence: the clock is called exactly once, here. UNKNOWN (valid
  // source, applicationHealthy null) keeps all factual fields and a normal
  // factual age.
  const now = nowMs();
  return {
    status: classified.status,
    summary: classified.summary,
    applicationId: classified.applicationId,
    source: classified.source,
    observedAt: classified.observedAt,
    evidenceAgeSeconds: Math.floor((now - Date.parse(evidence.observedAt)) / 1000),
    limitations: APP_HEALTH_LIMITATIONS,
  };
}