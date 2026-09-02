/**
 * engineering.deploy.status — public MVP tool (read-only, deterministic).
 *
 * Contract:
 * - Answers ONLY: "What deployment state is reported by the configured
 *   application/deployment evidence source?" It does NOT assess application
 *   health, VPS health, readiness to deploy, rollback suitability, failure
 *   root cause, or change safety.
 * - Input must be exactly {} (no parameters), enforced at the tool boundary
 *   (assertStrictEmptyInput) and at the MCP protocol layer
 *   (z.object({}).strict() -> additionalProperties: false).
 * - Evidence chain: the injected ApplicationDeploymentAdapter -> collect() ->
 *   validated ApplicationDeploymentEvidence -> the certified
 *   assessDeployStatus() classifier. Deployment classification is NOT
 *   duplicated here; no other signal (CPU, memory, uptime, git, Docker,
 *   network, LLM) is ever used.
 * - No adapter configured, or collect() returning null -> UNAVAILABLE with
 *   all evidence-derived fields null. A valid source reporting
 *   deploymentStatus: null -> UNKNOWN with factual fields preserved.
 *   Never throws for evidence failures and never exposes the configured
 *   path, file contents, filesystem/validation errors or stack traces.
 * - evidenceAgeSeconds is factual presentation only:
 *   floor((nowMs - Date.parse(observedAt)) / 1000). The clock is injectable
 *   for deterministic tests, called exactly once per invocation, and the age
 *   NEVER changes the verdict. Negative values are observable clock skew and
 *   are preserved, never clamped. No timer, polling, watch, cache, retry or
 *   max-age policy exists anywhere.
 */
import { z } from "zod";
import { assertStrictEmptyInput } from "./vpsHealth";
import { assessDeployStatus } from "./applicationDeployment";
import type { ApplicationDeploymentAdapter } from "../adapters/applicationDeployment";

export type DeployStatusToolStatus =
  | "OK"
  | "IN_FLIGHT"
  | "PENDING"
  | "FAILED"
  | "UNKNOWN"
  | "UNAVAILABLE";

export interface DeployStatusToolResult {
  status: DeployStatusToolStatus;
  summary: string;
  applicationId: string | null;
  source: string | null;
  observedAt: string | null;
  currentReleaseId: string | null;
  lastDeploymentFinishedAt: string | null;
  evidenceAgeSeconds: number | null;
  limitations: string[];
}

export const deployStatusOutputSchema = z.object({
  status: z.enum(["OK", "IN_FLIGHT", "PENDING", "FAILED", "UNKNOWN", "UNAVAILABLE"]),
  summary: z.string(),
  applicationId: z.string().nullable(),
  source: z.string().nullable(),
  observedAt: z.string().nullable(),
  currentReleaseId: z.string().nullable(),
  lastDeploymentFinishedAt: z.string().nullable(),
  evidenceAgeSeconds: z.number().int().nullable(),
  limitations: z.array(z.string()),
});

/** Fixed, factual limitations. Verdict-neutral wording; never mentions paths. */
export const DEPLOY_STATUS_LIMITATIONS: string[] = [
  "Read-only and advisory: reports only the deployment state reported by the configured evidence source; this tool triggers nothing.",
  "It does not assess application health, VPS health, readiness to deploy, rollback suitability, failure root cause, or change safety.",
  "Evidence comes only from the one operator-configured source; no other signal (CPU, memory, uptime, git, Docker, network) is used.",
  "evidenceAgeSeconds is factual evidence age only and never changes the verdict; a missing/invalid source yields UNAVAILABLE, a valid source without a deployment status yields UNKNOWN.",
];

const NO_ADAPTER_SUMMARY =
  "UNAVAILABLE: no application/deployment evidence source is configured for this " +
  "server; nothing was inferred.";

const EVIDENCE_FAILURE_SUMMARY =
  "UNAVAILABLE: the configured application/deployment evidence source returned no " +
  "valid evidence for this call; nothing was inferred.";

/**
 * Handle one engineering.deploy.status call.
 *
 * adapter: the construction-time evidence source, or null/undefined when the
 * operator configured none. nowMs defaults to the invocation-time clock and
 * is injectable for deterministic tests; it is called exactly once.
 */
export function handleDeployStatus(
  input: unknown,
  adapter: ApplicationDeploymentAdapter | null | undefined,
  nowMs: () => number = Date.now,
): DeployStatusToolResult {
  assertStrictEmptyInput(input);
  const now = nowMs();

  if (adapter === null || adapter === undefined) {
    return {
      status: "UNAVAILABLE",
      summary: NO_ADAPTER_SUMMARY,
      applicationId: null,
      source: null,
      observedAt: null,
      currentReleaseId: null,
      lastDeploymentFinishedAt: null,
      evidenceAgeSeconds: null,
      limitations: DEPLOY_STATUS_LIMITATIONS,
    };
  }

  const evidence = adapter.collect();
  const classified = assessDeployStatus(evidence);

  if (evidence === null) {
    // Delivery/validation failure: nothing may be exposed except the fixed
    // truthful reason. The certified classifier already returns UNAVAILABLE
    // with all evidence-derived fields null.
    return {
      status: classified.status,
      summary: EVIDENCE_FAILURE_SUMMARY,
      applicationId: classified.applicationId,
      source: classified.source,
      observedAt: classified.observedAt,
      currentReleaseId: classified.currentReleaseId,
      lastDeploymentFinishedAt: classified.lastDeploymentFinishedAt,
      evidenceAgeSeconds: null,
      limitations: DEPLOY_STATUS_LIMITATIONS,
    };
  }

  // Valid evidence: factual passthrough + factual age. UNKNOWN (valid source,
  // deploymentStatus null) keeps all factual fields and a normal age.
  return {
    status: classified.status,
    summary: classified.summary,
    applicationId: classified.applicationId,
    source: classified.source,
    observedAt: classified.observedAt,
    currentReleaseId: classified.currentReleaseId,
    lastDeploymentFinishedAt: classified.lastDeploymentFinishedAt,
    evidenceAgeSeconds: Math.floor((now - Date.parse(evidence.observedAt)) / 1000),
    limitations: DEPLOY_STATUS_LIMITATIONS,
  };
}
