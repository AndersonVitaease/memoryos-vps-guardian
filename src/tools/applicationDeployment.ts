/**
 * Pure deterministic application/deployment classifiers (public MVP).
 *
 * Future cores of engineering.app.health, engineering.deploy.status and
 * engineering.deploy.ready. Exported and tested, but NOT registered as MCP
 * tools in this sprint: the public MCP catalog remains exactly the four
 * certified tools.
 *
 * Properties:
 * - Pure functions of the supplied typed evidence only: no I/O, no clock,
 *   no randomness, no inference beyond the documented mappings.
 * - Evidence === null (no source configured, or the source returned nothing)
 *   maps deterministically to UNAVAILABLE. A null field inside valid
 *   evidence (the source cannot observe it) maps deterministically to
 *   UNKNOWN. Nothing is repaired, guessed or fabricated.
 * - assessDeployReady is ADVISORY ONLY: it composes the documented mappings
 *   with the existing pure VPS health/capacity assessments, triggers nothing
 *   and grants no deployment authority.
 *
 * Documented mappings:
 * - assessDeployStatus: SUCCEEDED -> OK, IN_PROGRESS -> IN_FLIGHT,
 *   QUEUED -> PENDING, FAILED -> FAILED, null -> UNKNOWN.
 * - assessApplicationHealth: true -> HEALTHY, false -> DEGRADED,
 *   null -> UNKNOWN.
 * - assessDeployReady: READY only when the deployment is neither IN_PROGRESS
 *   nor QUEUED, applicationHealthy === true, the existing VPS health is not
 *   DEGRADED, the existing VPS capacity is not PRESSURED, and no required
 *   component is UNKNOWN. Any required UNKNOWN -> UNKNOWN (UNKNOWN-first).
 */
import type {
  ApplicationDeploymentEvidence,
  ApplicationDeploymentStatus,
} from "../adapters/applicationDeployment";
import type { VpsHealthEvidence } from "../adapters/systemHealth";
import { assessVpsCapacity } from "./vpsCapacity";
import { assessVpsHealth } from "./vpsHealth";

export type ApplicationHealthStatus = "HEALTHY" | "DEGRADED" | "UNKNOWN" | "UNAVAILABLE";

export interface ApplicationHealthResult {
  status: ApplicationHealthStatus;
  summary: string;
  applicationId: string | null;
  source: string | null;
  observedAt: string | null;
}

export type DeployStatus = "OK" | "IN_FLIGHT" | "PENDING" | "FAILED" | "UNKNOWN" | "UNAVAILABLE";

export interface DeployStatusResult {
  status: DeployStatus;
  summary: string;
  applicationId: string | null;
  source: string | null;
  observedAt: string | null;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  lastDeploymentFinishedAt: string | null;
}

export type DeployReadinessStatus = "READY" | "NOT_READY" | "UNKNOWN" | "UNAVAILABLE";

export interface DeployReadyResult {
  status: DeployReadinessStatus;
  summary: string;
  applicationId: string | null;
  components: {
    deployment: DeployStatus;
    applicationHealth: ApplicationHealthStatus;
    vpsHealth: "HEALTHY" | "DEGRADED" | "UNKNOWN" | "UNAVAILABLE";
    vpsCapacity: "OK" | "PRESSURED" | "UNKNOWN" | "UNAVAILABLE";
  };
  /** Factual, non-causal blocking reasons; empty unless NOT_READY. */
  reasons: string[];
}

const UNAVAILABLE_SUMMARY =
  "UNAVAILABLE: a required evidence source returned no evidence for this call " +
  "(no source is configured, or the source returned nothing); nothing is inferred.";

const ADVISORY_NOTE =
  " Advisory only: this verdict triggers nothing and grants no deployment authority.";

export function assessApplicationHealth(
  evidence: ApplicationDeploymentEvidence | null,
): ApplicationHealthResult {
  if (evidence === null) {
    return {
      status: "UNAVAILABLE",
      summary: UNAVAILABLE_SUMMARY,
      applicationId: null,
      source: null,
      observedAt: null,
    };
  }

  const passthrough = {
    applicationId: evidence.applicationId,
    source: evidence.source,
    observedAt: evidence.observedAt,
  };

  if (evidence.applicationHealthy === true) {
    return {
      status: "HEALTHY",
      summary: "HEALTHY: the evidence source reports the application as healthy.",
      ...passthrough,
    };
  }
  if (evidence.applicationHealthy === false) {
    return {
      status: "DEGRADED",
      summary: "DEGRADED: the evidence source reports the application as not healthy.",
      ...passthrough,
    };
  }
  return {
    status: "UNKNOWN",
    summary: "UNKNOWN: applicationHealthy was not reported by the evidence source; no application health is inferred.",
    ...passthrough,
  };
}

export function assessDeployStatus(
  evidence: ApplicationDeploymentEvidence | null,
): DeployStatusResult {
  if (evidence === null) {
    return {
      status: "UNAVAILABLE",
      summary: UNAVAILABLE_SUMMARY,
      applicationId: null,
      source: null,
      observedAt: null,
      currentReleaseId: null,
      previousReleaseId: null,
      lastDeploymentFinishedAt: null,
    };
  }

  const reported: ApplicationDeploymentStatus | null = evidence.deploymentStatus;
  let status: DeployStatus;
  let summary: string;
  if (reported === "SUCCEEDED") {
    status = "OK";
    summary = "OK: the evidence source reports the deployment as SUCCEEDED.";
  } else if (reported === "IN_PROGRESS") {
    status = "IN_FLIGHT";
    summary = "IN_FLIGHT: the evidence source reports the deployment as IN_PROGRESS.";
  } else if (reported === "QUEUED") {
    status = "PENDING";
    summary = "PENDING: the evidence source reports the deployment as QUEUED.";
  } else if (reported === "FAILED") {
    status = "FAILED";
    summary = "FAILED: the evidence source reports the deployment as FAILED.";
  } else {
    status = "UNKNOWN";
    summary =
      "UNKNOWN: deploymentStatus was not reported by the evidence source; no deployment state is inferred.";
  }

  return {
    status,
    summary,
    applicationId: evidence.applicationId,
    source: evidence.source,
    observedAt: evidence.observedAt,
    currentReleaseId: evidence.currentReleaseId,
    previousReleaseId: evidence.previousReleaseId,
    lastDeploymentFinishedAt: evidence.lastDeploymentFinishedAt,
  };
}

export function assessDeployReady(
  evidence: ApplicationDeploymentEvidence | null,
  hostEvidence: VpsHealthEvidence | null,
): DeployReadyResult {
  const deployment = assessDeployStatus(evidence);
  const applicationHealth = assessApplicationHealth(evidence);
  const vpsHealth: "HEALTHY" | "DEGRADED" | "UNKNOWN" | "UNAVAILABLE" =
    hostEvidence === null ? "UNAVAILABLE" : assessVpsHealth(hostEvidence).status;
  const vpsCapacity: "OK" | "PRESSURED" | "UNKNOWN" | "UNAVAILABLE" =
    hostEvidence === null ? "UNAVAILABLE" : assessVpsCapacity(hostEvidence).status;

  const components = {
    deployment: deployment.status,
    applicationHealth: applicationHealth.status,
    vpsHealth,
    vpsCapacity,
  };
  const applicationId = evidence === null ? null : evidence.applicationId;

  if (evidence === null || hostEvidence === null) {
    return {
      status: "UNAVAILABLE",
      summary: UNAVAILABLE_SUMMARY,
      applicationId,
      components,
      reasons: [],
    };
  }

  // UNKNOWN-first: any required component without evidence -> UNKNOWN, never
  // READY or NOT_READY. Absence of evidence is never read as a positive.
  const unknownComponents = Object.entries(components)
    .filter(([, value]) => value === "UNKNOWN")
    .map(([key]) => key);
  if (unknownComponents.length > 0) {
    return {
      status: "UNKNOWN",
      summary: `UNKNOWN: required readiness component(s) could not be determined (${unknownComponents.join(", ")}); no readiness is inferred.`,
      applicationId,
      components,
      reasons: [],
    };
  }

  const reasons: string[] = [];
  if (deployment.status === "IN_FLIGHT") {
    reasons.push("the evidence source reports the deployment as IN_PROGRESS (in flight)");
  }
  if (deployment.status === "PENDING") {
    reasons.push("the evidence source reports the deployment as QUEUED (pending)");
  }
  if (applicationHealth.status === "DEGRADED") {
    reasons.push("the evidence source reports the application as not healthy");
  }
  if (vpsHealth === "DEGRADED") {
    reasons.push("the existing VPS health assessment is DEGRADED");
  }
  if (vpsCapacity === "PRESSURED") {
    reasons.push("the existing VPS capacity assessment is PRESSURED");
  }

  if (reasons.length > 0) {
    return {
      status: "NOT_READY",
      summary: `NOT_READY: ${reasons.join("; ")}.${ADVISORY_NOTE}`,
      applicationId,
      components,
      reasons,
    };
  }

  return {
    status: "READY",
    summary:
      "READY: the evidence source reports the application healthy and the deployment neither IN_PROGRESS nor QUEUED, and the existing VPS health and capacity assessments show no pressure." +
      ADVISORY_NOTE,
    applicationId,
    components,
    reasons: [],
  };
}
