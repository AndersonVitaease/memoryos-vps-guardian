/**
 * engineering.deploy.ready — public MVP tool (read-only, advisory, deterministic).
 *
 * Contract:
 * - Answers ONLY: "Based on currently configured validated operational
 *   evidence, does the application satisfy the minimum deterministic
 *   prerequisites for attempting a deployment?" It deploys nothing, approves
 *   nothing and grants no deployment, recovery or rollback authority. It does
 *   NOT predict deployment success and does not inspect code, migrations or
 *   release contents.
 * - Input must be exactly {} (no parameters), enforced at the tool boundary
 *   (assertStrictEmptyInput) and at the MCP protocol layer
 *   (z.object({}).strict() -> additionalProperties: false).
 * - Evidence chain: the injected ApplicationDeploymentAdapter -> collect() and
 *   the existing SystemHealthAdapter -> collect(), composed by the certified
 *   assessDeployReady(evidence, hostEvidence) classifier. Readiness logic is
 *   NOT duplicated here and no other tool's MCP output is consumed (no
 *   MCP-to-MCP recursion).
 * - No application adapter configured, application collect() returning null,
 *   or host evidence null -> UNAVAILABLE with all evidence-derived fields
 *   null. Valid evidence with an unknown required component -> UNKNOWN
 *   (UNKNOWN-first: absence of evidence is never read as a positive). Never
 *   throws for evidence failures and never exposes paths, filenames, raw
 *   evidence values, errors or stack traces.
 * - evidenceAgeSeconds is factual presentation only:
 *   floor((nowMs - Date.parse(observedAt)) / 1000). The clock is injectable
 *   for deterministic tests, called ONLY when valid application evidence
 *   exists (exactly once; zero calls on UNAVAILABLE branches); the age NEVER
 *   changes the status and negative values are preserved, never clamped. No
 *   timer, polling, watch, cache, retry or max-age policy exists anywhere.
 * - deploy.ready composes the four source Simple Tools' underlying certified
 *   classifiers; it never reinterprets or reconciles their MCP outputs.
 */
import { z } from "zod";
import { assertStrictEmptyInput } from "./vpsHealth";
import {
  assessDeployReady,
} from "./applicationDeployment";
import type { ApplicationDeploymentAdapter } from "../adapters/applicationDeployment";
import type { SystemHealthAdapter } from "../adapters/systemHealth";

export type DeployReadyToolStatus = "READY" | "NOT_READY" | "UNKNOWN" | "UNAVAILABLE";

export interface DeployReadyToolResult {
  status: DeployReadyToolStatus;
  summary: string;
  applicationId: string | null;
  components: {
    deployment: "OK" | "IN_FLIGHT" | "PENDING" | "FAILED" | "UNKNOWN" | "UNAVAILABLE";
    applicationHealth: "HEALTHY" | "DEGRADED" | "UNKNOWN" | "UNAVAILABLE";
    vpsHealth: "HEALTHY" | "DEGRADED" | "UNKNOWN" | "UNAVAILABLE";
    vpsCapacity: "OK" | "PRESSURED" | "UNKNOWN" | "UNAVAILABLE";
  };
  reasons: string[];
  evidenceAgeSeconds: number | null;
  limitations: string[];
}

const DEPLOYMENT_COMPONENTS = ["OK", "IN_FLIGHT", "PENDING", "FAILED", "UNKNOWN", "UNAVAILABLE"] as const;
const APPLICATION_HEALTH_COMPONENTS = ["HEALTHY", "DEGRADED", "UNKNOWN", "UNAVAILABLE"] as const;
const VPS_HEALTH_COMPONENTS = ["HEALTHY", "DEGRADED", "UNKNOWN", "UNAVAILABLE"] as const;
const VPS_CAPACITY_COMPONENTS = ["OK", "PRESSURED", "UNKNOWN", "UNAVAILABLE"] as const;

// Non-strict zod per codebase convention; exact shape enforced via Object.keys tests.
export const deployReadyOutputSchema = z.object({
  status: z.enum(["READY", "NOT_READY", "UNKNOWN", "UNAVAILABLE"]),
  summary: z.string(),
  applicationId: z.string().nullable(),
  components: z.object({
    deployment: z.enum(DEPLOYMENT_COMPONENTS),
    applicationHealth: z.enum(APPLICATION_HEALTH_COMPONENTS),
    vpsHealth: z.enum(VPS_HEALTH_COMPONENTS),
    vpsCapacity: z.enum(VPS_CAPACITY_COMPONENTS),
  }),
  reasons: z.array(z.string()),
  evidenceAgeSeconds: z.number().int().nullable(),
  limitations: z.array(z.string()),
});

/** Fixed, factual limitations. Verdict-neutral wording; never mentions paths. */
export const DEPLOY_READY_LIMITATIONS: string[] = [
  "Read-only and advisory: reports whether currently configured validated evidence satisfies minimum deterministic deployment prerequisites; this tool deploys nothing, approves nothing and grants no deployment or recovery authority.",
  "It does not predict deployment success and does not inspect code, migrations or release contents.",
  "Readiness is computed only by the certified readiness classifier over the configured application/deployment evidence source and local VPS health/capacity evidence; no other signal is used.",
  "evidenceAgeSeconds is factual evidence age only and never changes this status.",
  "UNKNOWN means required valid evidence is incomplete; UNAVAILABLE means a required evidence source is unavailable; absence of evidence is never read as READY.",
];

const NO_APPLICATION_ADAPTER_SUMMARY =
  "UNAVAILABLE: no application/deployment evidence source is configured for this " +
  "server; nothing was inferred.";

const APPLICATION_EVIDENCE_FAILURE_SUMMARY =
  "UNAVAILABLE: the configured application/deployment evidence source returned no " +
  "valid evidence for this call; nothing was inferred.";

const HOST_EVIDENCE_FAILURE_SUMMARY =
  "UNAVAILABLE: the configured VPS health evidence source returned no valid evidence " +
  "for this call; nothing was inferred.";

const UNAVAILABLE_COMPONENTS = {
  deployment: "UNAVAILABLE",
  applicationHealth: "UNAVAILABLE",
  vpsHealth: "UNAVAILABLE",
  vpsCapacity: "UNAVAILABLE",
} as const;

/**
 * Handle one engineering.deploy.ready call.
 *
 * applicationDeploymentAdapter: the construction-time application/deployment
 * evidence source, or null/undefined when the operator configured none.
 * systemHealthAdapter: the existing construction-time local VPS evidence
 * source. nowMs defaults to the invocation-time clock and is injectable for
 * deterministic tests; it is called ONLY when valid application evidence
 * exists (exactly once), never on the UNAVAILABLE branches.
 */
export function handleDeployReady(
  input: unknown,
  applicationDeploymentAdapter: ApplicationDeploymentAdapter | null | undefined,
  systemHealthAdapter: SystemHealthAdapter,
  nowMs: () => number = Date.now,
): DeployReadyToolResult {
  assertStrictEmptyInput(input);

  if (applicationDeploymentAdapter === null || applicationDeploymentAdapter === undefined) {
    // No application source configured: the clock is never consulted (0 calls).
    return {
      status: "UNAVAILABLE",
      summary: NO_APPLICATION_ADAPTER_SUMMARY,
      applicationId: null,
      components: UNAVAILABLE_COMPONENTS,
      reasons: [],
      evidenceAgeSeconds: null,
      limitations: DEPLOY_READY_LIMITATIONS,
    };
  }

  const applicationEvidence = applicationDeploymentAdapter.collect();
  const hostEvidence = systemHealthAdapter.collect();

  if (applicationEvidence === null) {
    // Delivery/validation failure: only the fixed truthful reason may be
    // exposed. The clock is never consulted.
    return {
      status: "UNAVAILABLE",
      summary: APPLICATION_EVIDENCE_FAILURE_SUMMARY,
      applicationId: null,
      components: UNAVAILABLE_COMPONENTS,
      reasons: [],
      evidenceAgeSeconds: null,
      limitations: DEPLOY_READY_LIMITATIONS,
    };
  }

  if (hostEvidence === null) {
    // Defensive: the certified host contract never returns null, but missing
    // host evidence must fail closed, never to READY.
    return {
      status: "UNAVAILABLE",
      summary: HOST_EVIDENCE_FAILURE_SUMMARY,
      applicationId: null,
      components: UNAVAILABLE_COMPONENTS,
      reasons: [],
      evidenceAgeSeconds: null,
      limitations: DEPLOY_READY_LIMITATIONS,
    };
  }

  // Valid application evidence: the clock is called exactly once, here.
  const now = nowMs();
  const classified = assessDeployReady(applicationEvidence, hostEvidence);
  return {
    status: classified.status,
    summary: classified.summary,
    applicationId: classified.applicationId,
    components: classified.components,
    reasons: classified.reasons,
    evidenceAgeSeconds: Math.floor((now - Date.parse(applicationEvidence.observedAt)) / 1000),
    limitations: DEPLOY_READY_LIMITATIONS,
  };
}