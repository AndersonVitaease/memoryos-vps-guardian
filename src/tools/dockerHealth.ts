/**
 * engineering.docker.health (Tool 08, public MVP).
 *
 * Public question answered (ONLY this): "Is the configured Docker/container
 * workload healthy?" — a deterministic, read-only, advisory verdict computed
 * ONLY from the operator-configured docker-health evidence source (a fixed
 * operator-controlled JSON file produced outside this process; see
 * adapters/dockerHealthFile.ts). This tool does NOT probe, inspect or control
 * Docker in any way: no Docker socket, no Docker Engine API, no docker CLI,
 * no child_process, no shell, no SSH, no network, no LLM, no mutation, no
 * deployment or recovery authority. Input must be exactly {} — the agent can
 * never select a container, host, path, socket or filter.
 *
 * Classification is a pure deterministic function of the evidence (see
 * assessDockerHealth): UNKNOWN-first (missing/incomplete/inconsistent
 * evidence is never read as DEGRADED or HEALTHY), no root-cause inference,
 * evidenceAgeSeconds is factual only and never changes the verdict.
 */
import { z } from "zod";
import { assertStrictEmptyInput } from "./vpsHealth";
import type {
  DockerHealthAdapter,
  DockerHealthEvidence,
} from "../adapters/dockerHealth";

export type DockerHealthStatus = "HEALTHY" | "DEGRADED" | "UNKNOWN" | "UNAVAILABLE";

export interface DockerHealthToolResult {
  status: DockerHealthStatus;
  summary: string;
  source: string | null;
  observedAt: string | null;
  evidenceAgeSeconds: number | null;
  containers: {
    total: number | null;
    running: number | null;
    unhealthy: number | null;
    restarting: number | null;
    stopped: number | null;
    unknown: number | null;
  };
  findings: string[];
  limitations: string[];
}

export const dockerHealthOutputSchema = z.object({
  status: z.enum(["HEALTHY", "DEGRADED", "UNKNOWN", "UNAVAILABLE"]),
  summary: z.string(),
  source: z.string().nullable(),
  observedAt: z.string().nullable(),
  evidenceAgeSeconds: z.number().int().nullable(),
  containers: z.object({
    total: z.number().int().nullable(),
    running: z.number().int().nullable(),
    unhealthy: z.number().int().nullable(),
    restarting: z.number().int().nullable(),
    stopped: z.number().int().nullable(),
    unknown: z.number().int().nullable(),
  }),
  findings: z.array(z.string()),
  limitations: z.array(z.string()),
});

export const DOCKER_HEALTH_LIMITATIONS: string[] = [
  "Read-only and advisory: this verdict triggers nothing and grants no deployment, recovery or container authority.",
  "It answers only from the one operator-configured docker-health evidence source; no other signal is used.",
  "It does not control or inspect Docker directly: no Docker socket, no Docker CLI, no shell, no network, no child processes.",
  "It reports aggregated counts only and never exposes container names, images, labels, mounts, commands or raw inspect data.",
  "UNKNOWN means the valid evidence is incomplete or inconsistent; UNAVAILABLE means the evidence source itself is unavailable; absence of evidence is never read as HEALTHY.",
];

const NO_ADAPTER_SUMMARY =
  "UNAVAILABLE: no docker/container health evidence source is configured for this server; nothing was inferred.";
const EVIDENCE_FAILURE_SUMMARY =
  "UNAVAILABLE: the configured docker/container health evidence source returned no valid evidence for this call; nothing was inferred.";

const NULL_CONTAINERS = {
  total: null,
  running: null,
  unhealthy: null,
  restarting: null,
  stopped: null,
  unknown: null,
} as const;

function unavailable(
  summary: string,
): DockerHealthToolResult {
  return {
    status: "UNAVAILABLE",
    summary,
    source: null,
    observedAt: null,
    evidenceAgeSeconds: null,
    containers: { ...NULL_CONTAINERS },
    findings: [],
    limitations: DOCKER_HEALTH_LIMITATIONS,
  };
}

/**
 * Certified-style pure deterministic classifier for docker.health.
 *
 * UNKNOWN-first: a null runtimeAvailable, any null aggregate count, any
 * unknown-container count > 0, or internally inconsistent aggregates
 * (running+unhealthy+restarting+stopped !== total) is UNKNOWN and is NEVER
 * converted into DEGRADED or HEALTHY. No root cause is ever inferred.
 */
export function assessDockerHealth(
  evidence: DockerHealthEvidence,
): Omit<DockerHealthToolResult, "limitations"> {
  const { containers } = evidence;
  const { total, running, unhealthy, restarting, stopped, unknown } = containers;

  if (
    evidence.runtimeAvailable === null ||
    total === null ||
    running === null ||
    unhealthy === null ||
    restarting === null ||
    stopped === null ||
    unknown === null
  ) {
    const missing: string[] = [];
    if (evidence.runtimeAvailable === null) {
      missing.push("runtimeAvailable");
    }
    if (total === null) {
      missing.push("total");
    }
    if (running === null) {
      missing.push("running");
    }
    if (unhealthy === null) {
      missing.push("unhealthy");
    }
    if (restarting === null) {
      missing.push("restarting");
    }
    if (stopped === null) {
      missing.push("stopped");
    }
    if (unknown === null) {
      missing.push("unknown");
    }
    return {
      status: "UNKNOWN",
      summary: `UNKNOWN: required container health state could not be determined (${missing.join(", ")}); no health verdict is inferred.`,
      source: evidence.source,
      observedAt: evidence.observedAt,
      evidenceAgeSeconds: null,
      containers: { ...containers },
      findings: [],
    };
  }

  if (unknown > 0) {
    return {
      status: "UNKNOWN",
      summary: `UNKNOWN: the evidence source could not determine the state of ${unknown} container(s); no health verdict is inferred.`,
      source: evidence.source,
      observedAt: evidence.observedAt,
      evidenceAgeSeconds: null,
      containers: { ...containers },
      findings: [],
    };
  }

  const accounted = running + unhealthy + restarting + stopped;
  if (accounted !== total) {
    return {
      status: "UNKNOWN",
      summary: "UNKNOWN: the aggregate container counts are internally inconsistent (running + unhealthy + restarting + stopped does not equal total); no health verdict is inferred.",
      source: evidence.source,
      observedAt: evidence.observedAt,
      evidenceAgeSeconds: null,
      containers: { ...containers },
      findings: [],
    };
  }

  const degraded =
    evidence.runtimeAvailable === false || unhealthy > 0 || restarting > 0 || stopped > 0;

  const findings: string[] = [];
  if (evidence.runtimeAvailable === false) {
    findings.push("the evidence source reports the container runtime as unavailable");
  }
  if (unhealthy > 0) {
    findings.push(`${unhealthy} container(s) reported unhealthy`);
  }
  if (restarting > 0) {
    findings.push(`${restarting} container(s) reported restarting`);
  }
  if (stopped > 0) {
    findings.push(`${stopped} container(s) reported stopped`);
  }
  if (!degraded && running > 0) {
    findings.push(`${running} container(s) reported running`);
  }

  return {
    status: degraded ? "DEGRADED" : "HEALTHY",
    summary: degraded
      ? `DEGRADED: the evidence source reports the configured container workload as not fully healthy (${findings.join("; ")}).`
      : "HEALTHY: the evidence source reports the container runtime available and all configured containers running.",
    source: evidence.source,
    observedAt: evidence.observedAt,
    evidenceAgeSeconds: null,
    containers: { ...containers },
    findings: degraded ? findings : findings,
  };
}

/**
 * Tool handler. Clock semantics identical to app.health/deploy.ready:
 * nowMs() is called exactly once and only when valid evidence exists; on
 * every UNAVAILABLE branch it is never called.
 */
export function handleDockerHealth(
  input: unknown,
  dockerHealthAdapter: DockerHealthAdapter | null | undefined,
  nowMs: () => number = Date.now,
): DockerHealthToolResult {
  assertStrictEmptyInput(input);

  if (dockerHealthAdapter === null || dockerHealthAdapter === undefined) {
    return unavailable(NO_ADAPTER_SUMMARY);
  }

  const evidence = dockerHealthAdapter.collect();
  if (evidence === null) {
    return unavailable(EVIDENCE_FAILURE_SUMMARY);
  }

  const now = nowMs();
  const assessed = assessDockerHealth(evidence);
  return {
    status: assessed.status,
    summary: assessed.summary,
    source: assessed.source,
    observedAt: assessed.observedAt,
    evidenceAgeSeconds: Math.floor((now - Date.parse(evidence.observedAt)) / 1000),
    containers: assessed.containers,
    findings: assessed.findings,
    limitations: DOCKER_HEALTH_LIMITATIONS,
  };
}
