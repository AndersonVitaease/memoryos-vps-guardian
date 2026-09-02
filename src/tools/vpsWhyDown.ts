/**
 * engineering.vps.why_down — public tool (read-only, deterministic diagnostic).
 *
 * Answers one narrow goal: "Why does the currently configured VPS/application
 * appear unhealthy?" — concretely, three things and nothing more:
 * 1. Is there evidence of a problem?
 * 2. What concrete signals are currently observed?
 * 3. What cannot be determined from the available evidence?
 *
 * This is a deterministic COMPOSITION of already-certified evidence, not a new
 * evidence implementation:
 * - ONE SystemHealthAdapter.collect() snapshot feeds the existing pure
 *   assessVpsHealth() and assessVpsCapacity() functions (same composition
 *   pattern as engineering.vps.incident.summary; no threshold duplication).
 * - When an application/deployment source is configured, ONE collect() feeds
 *   the existing assessApplicationHealth() and assessDeployStatus().
 * - When a docker-health source is configured, ONE collect() feeds the
 *   existing assessDockerHealth() from engineering.docker.health (direct
 *   code reuse — no MCP tool-to-tool recursion, no duplicated Docker logic).
 * - ZERO new evidence transport: no new filesystem source, no new environment
 *   variable, no Docker socket, no child process, no shell, no SSH, no
 *   network probe, no new credentials, no new runtime dependency.
 *
 * Signals, not causes:
 * - Each signal is a normalized {category, source, status, summary} triple
 *   produced by an existing classifier. Categories are exactly VPS_HEALTH,
 *   CAPACITY, APPLICATION_HEALTH, DEPLOYMENT and DOCKER.
 * - Problem predicates are factual only: VPS health DEGRADED, capacity
 *   PRESSURED, application health DEGRADED, deployment FAILED and docker
 *   DEGRADED. A deployment IN_FLIGHT or PENDING is reported factually and is
 *   NOT a problem signal (it is normal operation).
 * - Correlation is never presented as causation: when several degraded
 *   signals co-occur, all are reported and none is chosen as THE cause. No
 *   rootCause/cause/diagnosis field exists.
 *
 * Overall precedence (UNKNOWN-first; missing evidence is never a failure):
 * - UNAVAILABLE: no evidence source is configured at all (no signal observed).
 * - UNKNOWN: at least one observed signal is UNKNOWN (incomplete/inconsistent
 *   evidence) or UNAVAILABLE (a configured source returned no evidence).
 * - DEGRADED: at least one factual problem signal is observed.
 * - HEALTHY: all observed signals report no degraded or problem condition.
 * A category with no configured source is absent from signals and its
 * condition is stated as unknown in the limitations; it is never read as
 * HEALTHY. Docker evidence being unavailable never by itself implies failure.
 *
 * Contract: input must be exactly {} (same shared assertion and
 * z.object({}).strict() protocol enforcement as the other tools). No clock:
 * evidence age is verdict-neutral and remains available from the underlying
 * tools. No mutation, no shell, no SSH, no LLM, no network, no secrets, no
 * private dependencies.
 */

import { z } from "zod";
import type {
  ApplicationDeploymentAdapter,
} from "../adapters/applicationDeployment";
import type { DockerHealthAdapter } from "../adapters/dockerHealth";
import type { SystemHealthAdapter } from "../adapters/systemHealth";
import { assessApplicationHealth, assessDeployStatus } from "./applicationDeployment";
import { assessDockerHealth } from "./dockerHealth";
import type { DockerHealthToolResult } from "./dockerHealth";
import { assessVpsCapacity } from "./vpsCapacity";
import { assessVpsHealth, assertStrictEmptyInput } from "./vpsHealth";

export type WhyDownStatus = "HEALTHY" | "DEGRADED" | "UNKNOWN" | "UNAVAILABLE";

export type WhyDownSignalCategory =
  | "VPS_HEALTH"
  | "CAPACITY"
  | "APPLICATION_HEALTH"
  | "DEPLOYMENT"
  | "DOCKER";

export interface WhyDownSignal {
  category: WhyDownSignalCategory;
  /** Provenance of the evidence line; null when the source returned no evidence. */
  source: string | null;
  /** The underlying classifier verdict (e.g. DEGRADED, PRESSURED, FAILED). */
  status: string;
  /** The underlying classifier's normalized summary; no raw evidence. */
  summary: string;
}

export interface WhyDownResult {
  status: WhyDownStatus;
  summary: string;
  signals: WhyDownSignal[];
  limitations: string[];
}

/**
 * One per-category observation handed to the pure synthesis.
 * - absent:   no evidence source is configured for this category.
 * - observed: a source was configured and produced a classifier verdict
 *             (UNAVAILABLE is used verbatim when a configured source
 *             returned no evidence for this call).
 */
export type WhyDownObservation =
  | { readonly kind: "absent" }
  | {
      readonly kind: "observed";
      readonly status: string;
      readonly summary: string;
      readonly source: string | null;
    };

export type WhyDownAssessmentInput = Readonly<
  Record<WhyDownSignalCategory, WhyDownObservation>
>;

export const vpsWhyDownOutputSchema = z.object({
  status: z.enum(["HEALTHY", "DEGRADED", "UNKNOWN", "UNAVAILABLE"]),
  summary: z.string(),
  signals: z.array(
    z.object({
      category: z.enum([
        "VPS_HEALTH",
        "CAPACITY",
        "APPLICATION_HEALTH",
        "DEPLOYMENT",
        "DOCKER",
      ]),
      source: z.string().nullable(),
      status: z.string(),
      summary: z.string(),
    }),
  ),
  limitations: z.array(z.string()),
});

export const WHY_DOWN_LIMITATIONS: string[] = [
  "Read-only and advisory: this verdict triggers nothing and grants no recovery, deployment or remediation authority.",
  "It synthesizes only evidence already available to this server (local VPS health and capacity, plus the operator-configured application/deployment and docker-health sources when present); it collects no new evidence.",
  "Signals are observations, not causes: correlation is never presented as causation and no root cause is inferred, even when several degraded signals co-occur.",
  "No shell, no SSH, no network probe, no Docker socket, no child processes and no log access: application logs, containers and processes are not inspected.",
  "A category missing from signals has no evidence source configured on this server; its condition is not known and is never read as HEALTHY.",
];

const CATEGORY_ORDER: readonly WhyDownSignalCategory[] = [
  "VPS_HEALTH",
  "CAPACITY",
  "APPLICATION_HEALTH",
  "DEPLOYMENT",
  "DOCKER",
];

/** Factual, non-causal problem predicates per category (explicit and testable). */
function isProblemSignal(category: WhyDownSignalCategory, status: string): boolean {
  switch (category) {
    case "VPS_HEALTH":
    case "APPLICATION_HEALTH":
    case "DOCKER":
      return status === "DEGRADED";
    case "CAPACITY":
      return status === "PRESSURED";
    case "DEPLOYMENT":
      return status === "FAILED";
  }
}

/** A signal whose evidence is incomplete, inconsistent or returned nothing. */
function isAmbiguousSignal(status: string): boolean {
  return status === "UNKNOWN" || status === "UNAVAILABLE";
}

function formatSignals(signals: WhyDownSignal[]): string {
  return signals.map((signal) => `${signal.category}: ${signal.status}`).join("; ");
}

/**
 * Certified-style pure deterministic synthesis for why_down.
 * UNKNOWN-first: any UNKNOWN/UNAVAILABLE signal makes the overall verdict
 * UNKNOWN and is NEVER converted into DEGRADED or HEALTHY. Missing evidence
 * is never fabricated into a cause.
 */
export function assessWhyDown(input: WhyDownAssessmentInput): WhyDownResult {
  const signals: WhyDownSignal[] = [];
  for (const category of CATEGORY_ORDER) {
    const observation = input[category];
    if (observation.kind === "absent") continue;
    signals.push({
      category,
      source: observation.source,
      status: observation.status,
      summary: observation.summary,
    });
  }

  if (signals.length === 0) {
    return {
      status: "UNAVAILABLE",
      summary:
        "UNAVAILABLE: no evidence source is configured on this server, so no signal could be observed; nothing is inferred.",
      signals,
      limitations: WHY_DOWN_LIMITATIONS,
    };
  }

  const ambiguous = signals.filter((signal) => isAmbiguousSignal(signal.status));
  const problems = signals.filter((signal) => isProblemSignal(signal.category, signal.status));

  if (ambiguous.length > 0) {
    const problemPart =
      problems.length > 0
        ? `; problem signal(s) were also observed (${formatSignals(problems)})`
        : "";
    return {
      status: "UNKNOWN",
      summary: `UNKNOWN: evidence is incomplete or unavailable for ${ambiguous.length} signal(s) (${formatSignals(ambiguous)})${problemPart}; no reliable verdict is inferred.`,
      signals,
      limitations: WHY_DOWN_LIMITATIONS,
    };
  }

  if (problems.length > 0) {
    return {
      status: "DEGRADED",
      summary: `DEGRADED: ${problems.length} signal(s) report a degraded or problem condition (${formatSignals(problems)}); this is an observed correlation, not a causal diagnosis.`,
      signals,
      limitations: WHY_DOWN_LIMITATIONS,
    };
  }

  return {
    status: "HEALTHY",
    summary: `HEALTHY: all ${signals.length} observed signal(s) report no degraded or problem condition.`,
    signals,
    limitations: WHY_DOWN_LIMITATIONS,
  };
}

/**
 * Tool handler. Deterministic composition of the adapters already wired by
 * buildServer(): ONE local system-health snapshot for VPS_HEALTH + CAPACITY,
 * ONE release-state snapshot (when configured) for APPLICATION_HEALTH +
 * DEPLOYMENT, and ONE docker-health snapshot (when configured) for DOCKER.
 * Categories without a configured source stay absent from signals.
 */
export function handleVpsWhyDown(
  input: unknown,
  systemHealthAdapter: SystemHealthAdapter,
  applicationDeploymentAdapter: ApplicationDeploymentAdapter | null | undefined,
  dockerHealthAdapter: DockerHealthAdapter | null | undefined,
): WhyDownResult {
  assertStrictEmptyInput(input);

  // ONE snapshot feeds both local classifiers (same as incident.summary).
  const systemEvidence = systemHealthAdapter.collect();
  const vpsHealth = assessVpsHealth(systemEvidence);
  const capacity = assessVpsCapacity(systemEvidence);

  let applicationHealth: WhyDownObservation = { kind: "absent" };
  let deployment: WhyDownObservation = { kind: "absent" };
  if (applicationDeploymentAdapter !== null && applicationDeploymentAdapter !== undefined) {
    const evidence = applicationDeploymentAdapter.collect();
    if (evidence === null) {
      const unavailableSummary =
        "UNAVAILABLE: the configured application/deployment evidence source returned no evidence for this call; nothing was inferred.";
      applicationHealth = { kind: "observed", status: "UNAVAILABLE", summary: unavailableSummary, source: null };
      deployment = { kind: "observed", status: "UNAVAILABLE", summary: unavailableSummary, source: null };
    } else {
      const appHealth = assessApplicationHealth(evidence);
      const deployStatus = assessDeployStatus(evidence);
      applicationHealth = {
        kind: "observed",
        status: appHealth.status,
        summary: appHealth.summary,
        source: appHealth.source,
      };
      deployment = {
        kind: "observed",
        status: deployStatus.status,
        summary: deployStatus.summary,
        source: deployStatus.source,
      };
    }
  }

  let docker: WhyDownObservation = { kind: "absent" };
  if (dockerHealthAdapter !== null && dockerHealthAdapter !== undefined) {
    const evidence = dockerHealthAdapter.collect();
    if (evidence === null) {
      docker = {
        kind: "observed",
        status: "UNAVAILABLE",
        summary:
          "UNAVAILABLE: the configured docker-health evidence source returned no evidence for this call; nothing was inferred.",
        source: null,
      };
    } else {
      const assessed: Omit<DockerHealthToolResult, "limitations"> = assessDockerHealth(evidence);
      docker = {
        kind: "observed",
        status: assessed.status,
        summary: assessed.summary,
        source: assessed.source,
      };
    }
  }

  return assessWhyDown({
    VPS_HEALTH: {
      kind: "observed",
      status: vpsHealth.status,
      summary: vpsHealth.summary,
      source: systemHealthAdapter.name,
    },
    CAPACITY: {
      kind: "observed",
      status: capacity.status,
      summary: capacity.summary,
      source: systemHealthAdapter.name,
    },
    APPLICATION_HEALTH: applicationHealth,
    DEPLOYMENT: deployment,
    DOCKER: docker,
  });
}
