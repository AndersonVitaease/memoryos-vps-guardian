/**
 * MCP server for MemoryOS VPS Guardian — public MVP.
 *
 * Registers the implemented tools: engineering.vps.health,
 * engineering.vps.capacity, engineering.vps.what_changed,
 * engineering.vps.incident.summary, engineering.deploy.status,
 * engineering.app.health, engineering.deploy.ready,
 * engineering.docker.health, engineering.vps.why_down and
 * engineering.logs.explain (read-only, deterministic). The
 * what_changed instance is created per buildServer() call and shared with the
 * incident summary composition: its baseline and last observation live only
 * in the memory of this process.
 * The AI receives a goal-oriented tool, not a terminal: no shell, no SSH, no LLM,
 * no network access, no secrets, no mutation.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { handleVpsHealth, vpsHealthOutputSchema } from "./tools/vpsHealth";
import { handleVpsCapacity, vpsCapacityOutputSchema } from "./tools/vpsCapacity";
import { createVpsWhatChangedTool, vpsWhatChangedOutputSchema } from "./tools/vpsWhatChanged";
import { createVpsIncidentSummaryTool, vpsIncidentSummaryOutputSchema } from "./tools/vpsIncidentSummary";
import { handleDeployStatus, deployStatusOutputSchema } from "./tools/deployStatus";
import { handleAppHealth, appHealthOutputSchema } from "./tools/appHealth";
import { handleDeployReady, deployReadyOutputSchema } from "./tools/deployReady";
import { localSystemHealthAdapter } from "./adapters/systemHealth";
import { createReleaseStateFileAdapter } from "./adapters/releaseStateFile";
import type { ApplicationDeploymentAdapter } from "./adapters/applicationDeployment";
import { handleDockerHealth, dockerHealthOutputSchema } from "./tools/dockerHealth";
import { createDockerHealthFileAdapter } from "./adapters/dockerHealthFile";
import type { DockerHealthAdapter } from "./adapters/dockerHealth";
import { handleVpsWhyDown, vpsWhyDownOutputSchema } from "./tools/vpsWhyDown";
import { handleLogsExplain, logsExplainOutputSchema } from "./tools/logsExplain";
import { createLogEvidenceFileAdapter } from "./adapters/logEvidenceFile";
import type { LogEvidenceAdapter } from "./adapters/logEvidence";
export interface BuildServerOptions {
  /**
   * Optional construction-time application/deployment evidence source
   * (e.g. the release-state file adapter). When absent (undefined or null),
   * engineering.deploy.status is still registered and truthfully reports
   * UNAVAILABLE. The path authority lives entirely with the operator; the
   * MCP agent can never supply or change it.
   */
  applicationDeploymentAdapter?: ApplicationDeploymentAdapter | null;

  /**
   * Optional construction-time docker/container health evidence source
   * (e.g. the docker-health file adapter). When absent (undefined or null),
   * engineering.docker.health is still registered and truthfully reports
   * UNAVAILABLE. The path authority lives entirely with the operator; the
   * MCP agent can never supply or change it.
   */
  dockerHealthAdapter?: DockerHealthAdapter | null;

  /**
   * Optional construction-time log evidence source (e.g. the log-evidence
   * file adapter). When absent (undefined or null), engineering.logs.explain
   * is still registered and truthfully reports UNAVAILABLE. The path
   * authority lives entirely with the operator; the MCP agent can never
   * supply or change it.
   */
  logsEvidenceAdapter?: LogEvidenceAdapter | null;
}

export function buildServer(options: BuildServerOptions = {}): McpServer {
  const server = new McpServer({ name: "memoryos-vps-guardian", version: "0.1.0" });

  server.registerTool(
    "engineering.vps.health",
    {
      title: "VPS health",
      description:
        "Is my VPS healthy? Returns a deterministic read-only verdict " +
        "(HEALTHY | DEGRADED | UNKNOWN) built from local OS evidence only " +
        "(uptime, CPUs, load average, memory). Input must be exactly {}. " +
        "No mutation, no shell, no SSH, no network, no secrets.",
      inputSchema: z.object({}).strict(),
      outputSchema: vpsHealthOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = handleVpsHealth(args, localSystemHealthAdapter);
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );

  server.registerTool(
    "engineering.vps.capacity",
    {
      title: "VPS capacity",
      description:
        "Is my VPS close to its capacity limits? Returns a deterministic read-only " +
        "pressure assessment (OK | PRESSURED | UNKNOWN) for CPU load and memory, " +
        "built from local OS evidence only. Current state only — no capacity " +
        "prediction and no upgrade advice. Input must be exactly {}. " +
        "No mutation, no shell, no SSH, no network, no secrets.",
      inputSchema: z.object({}).strict(),
      outputSchema: vpsCapacityOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = handleVpsCapacity(args, localSystemHealthAdapter);
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );

  // Session-scoped instance: its in-memory baseline and last observation live
  // only inside this server/process. A fresh session starts a new baseline.
  const whatChangedTool = createVpsWhatChangedTool(localSystemHealthAdapter);

  server.registerTool(
    "engineering.vps.what_changed",
    {
      title: "VPS what changed",
      description:
        "What changed since the previous observation made by this MCP process? " +
        "Session/process scoped: the first call creates the baseline " +
        "(BASELINE_CREATED) and later calls compare the current OS evidence " +
        "(uptime, CPU count, load, memory) against the previous observation of " +
        "THIS process. Restarting the server resets all history. It does NOT " +
        "provide deployment, file, service or container history and knows " +
        "nothing before its baseline. Input must be exactly {}. " +
        "No mutation, no shell, no SSH, no network, no secrets.",
      inputSchema: z.object({}).strict(),
      outputSchema: vpsWhatChangedOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = whatChangedTool.handle(args);
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );

  // Deterministic composition: ONE adapter snapshot for health+capacity and the
  // SAME session-scoped what_changed instance/history as above. This tool call
  // counts as one what_changed observation (documented semantics).
  const incidentSummaryTool = createVpsIncidentSummaryTool(
    localSystemHealthAdapter,
    whatChangedTool,
  );

  server.registerTool(
    "engineering.vps.incident.summary",
    {
      title: "VPS incident summary",
      description:
        "Deterministic composition summary: what is happening on this VPS right now " +
        "according to the local evidence observed by this MCP process? Combines the " +
        "current health, capacity and change observations. It shares the session " +
        "history of engineering.vps.what_changed: calling this tool counts as one " +
        "observation. Returns NORMAL, ATTENTION or UNKNOWN with compact factual " +
        "notes and fixed limitations. It never claims a root cause and does NOT " +
        "observe applications, services, containers, deployments or logs. " +
        "Input must be exactly {}. No mutation, no shell, no SSH, no network, no secrets.",
      inputSchema: z.object({}).strict(),
      outputSchema: vpsIncidentSummaryOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = incidentSummaryTool.handle(args);
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );

  // Construction-time, operator-controlled evidence source for
  // engineering.deploy.status. Registered unconditionally: without a
  // configured source the tool truthfully reports UNAVAILABLE (never hidden,
  // never fabricated, never throwing). The adapter performs its own strict
  // validation and fail-closed collection; no MCP argument carries evidence.
  const applicationDeploymentAdapter = options.applicationDeploymentAdapter ?? null;
  const dockerHealthAdapter = options.dockerHealthAdapter ?? null;
  const logEvidenceAdapter = options.logsEvidenceAdapter ?? null;

  server.registerTool(
    "engineering.deploy.status",
    {
      title: "Deployment status",
      description:
        "What deployment state is reported by the configured application/deployment " +
        "evidence source? Deterministic read-only verdict (OK | IN_FLIGHT | PENDING | " +
        "FAILED | UNKNOWN | UNAVAILABLE) built ONLY from the operator-configured " +
        "release-state evidence source (MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE, " +
        "read-only JSON file). UNAVAILABLE means no source is configured or it " +
        "returned no valid evidence; UNKNOWN means a valid source explicitly " +
        "reported no deployment status. evidenceAgeSeconds is factual evidence age " +
        "and never changes the verdict. It does not assess application health, VPS " +
        "health, readiness to deploy or failure causes. Input must be exactly {}. " +
        "No mutation, no shell, no SSH, no network, no secrets.",
      inputSchema: z.object({}).strict(),
      outputSchema: deployStatusOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = handleDeployStatus(args, applicationDeploymentAdapter);
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );

  // Construction-time evidence source shared with engineering.deploy.status.
  // Registered unconditionally: without a configured source the tool
  // truthfully reports UNAVAILABLE. It consumes the SAME injected
  // ApplicationDeploymentAdapter — no second env variable, transport, adapter
  // or config source exists. app.health and deploy.status answer different
  // questions through different certified classifiers and never reconcile
  // each other.
  server.registerTool(
    "engineering.app.health",
    {
      title: "Application health",
      description:
        "What application health state is reported by the configured validated " +
        "application/deployment evidence source? Deterministic read-only verdict " +
        "(HEALTHY | DEGRADED | UNKNOWN | UNAVAILABLE) built ONLY from the " +
        "operator-configured release-state evidence source " +
        "(MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE, read-only JSON file) — the " +
        "same source and configuration as engineering.deploy.status; no new " +
        "configuration. UNAVAILABLE means no source is configured or it returned " +
        "no valid evidence; UNKNOWN means a valid source explicitly reported no " +
        "application health. evidenceAgeSeconds is factual evidence age and never " +
        "changes the status. It does NOT probe the application, inspect Docker, " +
        "call HTTP, infer health from deployment status, or diagnose root cause. " +
        "Input must be exactly {}. No mutation, no shell, no SSH, no network, no " +
        "secrets.",
      inputSchema: z.object({}).strict(),
      outputSchema: appHealthOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = handleAppHealth(args, applicationDeploymentAdapter);
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );

  // Deterministic advisory composition over the SAME construction-time
  // evidence sources already injected by 05C (application/deployment adapter)
  // and the existing local VPS evidence adapter. Registered unconditionally:
  // without a configured application source the tool truthfully reports
  // UNAVAILABLE. It reuses the certified assessDeployReady classifier — no
  // readiness logic is duplicated, no MCP tool output is consumed, and it
  // grants no deployment authority.
  server.registerTool(
    "engineering.deploy.ready",
    {
      title: "Deployment readiness",
      description:
        "Based on currently configured validated operational evidence, does the " +
        "application satisfy the minimum deterministic prerequisites for attempting " +
        "a deployment? Deterministic read-only advisory verdict (READY | NOT_READY | " +
        "UNKNOWN | UNAVAILABLE) computed ONLY by the certified readiness classifier " +
        "over the operator-configured release-state evidence source " +
        "(MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE, the same source as " +
        "engineering.deploy.status) and existing local VPS health/capacity evidence " +
        "— no new configuration. UNKNOWN means required valid evidence is incomplete; " +
        "UNAVAILABLE means a required evidence source is unavailable. " +
        "evidenceAgeSeconds is factual and never changes the verdict. Advisory only: " +
        "this tool deploys nothing, approves nothing, grants no deployment or " +
        "recovery authority, does not predict deployment success and does not " +
        "inspect code, migrations or release contents. Input must be exactly {}. No " +
        "mutation, no shell, no SSH, no network, no secrets.",
      inputSchema: z.object({}).strict(),
      outputSchema: deployReadyOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = handleDeployReady(args, applicationDeploymentAdapter, localSystemHealthAdapter);
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );

  // Tool 08: registered unconditionally; without an operator-configured
  // docker-health evidence source it truthfully reports UNAVAILABLE.
  server.registerTool(
    "engineering.docker.health",
    {
      title: "Docker container health",
      description:
        'Is the configured Docker/container workload healthy? Deterministic read-only advisory verdict ' +
        "(HEALTHY | DEGRADED | UNKNOWN | UNAVAILABLE) computed ONLY from the operator-configured docker-health " +
        "evidence source (MEMORYOS_VPS_GUARDIAN_DOCKER_HEALTH_FILE, one fixed operator-controlled JSON file " +
        "produced outside this process; aggregated counts only). This tool does NOT access the Docker socket, " +
        "does NOT run the docker CLI, and does NOT probe containers: no shell, no SSH, no network, no secrets, " +
        "no LLM, no mutation, no deployment or recovery authority. It never infers root causes; UNKNOWN means " +
        "the valid evidence is incomplete or inconsistent, UNAVAILABLE means the evidence source is unavailable; " +
        "absence of evidence is never read as HEALTHY. Input must be exactly {} — the agent can never select a " +
        "container, host, path or socket.",
      inputSchema: z.object({}).strict(),
      outputSchema: dockerHealthOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = handleDockerHealth(args, dockerHealthAdapter);
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );

  // Tool 09: registered unconditionally; deterministic synthesis of evidence
  // already available to this server (local VPS health/capacity always, plus
  // the optional application/deployment and docker-health sources when
  // configured). Without any optional source it still reports the local VPS
  // signals truthfully; missing categories are absent from signals.
  server.registerTool(
    "engineering.vps.why_down",
    {
      title: "VPS / application problem signals",
      description:
        'Why does the currently configured VPS/application appear unhealthy? Deterministic read-only diagnostic ' +
        "synthesis of the evidence already available to this server: local VPS health and capacity plus the " +
        "operator-configured application/deployment and docker-health sources when present. It reports normalized " +
        "signals (VPS_HEALTH, CAPACITY, APPLICATION_HEALTH, DEPLOYMENT, DOCKER), what is degraded, what is unknown " +
        "and what is not observable — SIGNALS, not root causes: correlation is never presented as causation and no " +
        "recovery or deployment authority exists. No shell, no SSH, no network probe, no Docker socket, no logs, " +
        "no secrets, no LLM, no mutation. Input must be exactly {} — the agent can never select a host, " +
        "application, container or path.",
      inputSchema: z.object({}).strict(),
      outputSchema: vpsWhyDownOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = handleVpsWhyDown(args, localSystemHealthAdapter, applicationDeploymentAdapter, dockerHealthAdapter);
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );

  // Tool 10: registered unconditionally; without an operator-configured
  // log-evidence source it truthfully reports UNAVAILABLE. It is NOT a log
  // browser: the ONLY evidence is the one operator-fixed structured JSON
  // file configured at startup; no MCP argument carries evidence.
  server.registerTool(
    "engineering.logs.explain",
    {
      title: "Log signal explanations",
      description:
        'What do the currently configured operational log signals mean? Deterministic read-only advisory explanations ' +
        "(EXPLAINED | UNKNOWN | UNAVAILABLE) computed ONLY from the operator-configured log-evidence source " +
        "(MEMORYOS_VPS_GUARDIAN_LOG_EVIDENCE_FILE, one fixed operator-controlled structured JSON file of already-normalized " +
        "log signals produced outside this process). NOT a log browser: it never reads raw logs, never tails or watches " +
        "files, never runs grep, journalctl or docker logs, and never touches the Docker socket. Classification is a small " +
        "deterministic taxonomy (out-of-memory, connection refused, timeout, port-bind failure, DNS failure, health-check " +
        "failure, process exit, permission failure) matched from producer-supplied codes first; unclassifiable signals " +
        "are reported as UNKNOWN and evidence messages are never returned. Explanations are advisory: no shell, no SSH, " +
        "no child processes, no network, no LLM, no mutation, no recovery authority. Input must be exactly {} — the agent " +
        "can never select a path, file, container, service, journal, query or time range.",
      inputSchema: z.object({}).strict(),
      outputSchema: logsExplainOutputSchema,
    },
    async (args: unknown) => {
      try {
        const result = handleLogsExplain(args, logEvidenceAdapter);
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : "invalid input" },
          ],
        };
      }
    },
  );

  return server;
}

/** The single optional startup environment variable for the evidence source. */
export const RELEASE_STATE_FILE_ENV_VAR = "MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE";

/** The single optional startup environment variable for the docker-health evidence source. */
export const DOCKER_HEALTH_FILE_ENV_VAR = "MEMORYOS_VPS_GUARDIAN_DOCKER_HEALTH_FILE";

/**
 * Startup-only wiring: map the ONE approved operator-controlled environment
 * variable to the docker-health file adapter, exactly like the release-state
 * wiring. Read exactly once, only when main() runs; undefined or "" means no
 * adapter (the tool then reports UNAVAILABLE). No trimming, no coercion, no
 * dynamic reload; the configured value is never echoed. Any non-empty value
 * is validated by createDockerHealthFileAdapter, which throws at construction
 * on an invalid operator path.
 */
export function createDockerHealthAdapterFromEnvironment(
  read: (name: string) => string | undefined = (name) => process.env[name],
): DockerHealthAdapter | null {
  const configured = read(DOCKER_HEALTH_FILE_ENV_VAR);
  if (configured === undefined || configured === "") {
    return null;
  }
  return createDockerHealthFileAdapter({ path: configured });
}

/** The single optional startup environment variable for the log evidence source. */
export const LOG_EVIDENCE_FILE_ENV_VAR = "MEMORYOS_VPS_GUARDIAN_LOG_EVIDENCE_FILE";

/**
 * Startup-only wiring: map the ONE approved operator-controlled environment
 * variable to the log-evidence file adapter, exactly like the docker-health
 * wiring. Read exactly once, only when main() runs; undefined or "" means no
 * adapter (the tool then reports UNAVAILABLE). No trimming, no coercion, no
 * dynamic reload; the configured value is never echoed. Any non-empty value
 * is validated by createLogEvidenceFileAdapter, which throws at construction
 * on an invalid operator path.
 */
export function createLogEvidenceAdapterFromEnvironment(
  read: (name: string) => string | undefined = (name) => process.env[name],
): LogEvidenceAdapter | null {
  const configured = read(LOG_EVIDENCE_FILE_ENV_VAR);
  if (configured === undefined || configured === "") {
    return null;
  }
  return createLogEvidenceFileAdapter({ path: configured });
}

/**
 * Startup-only wiring: map the ONE approved operator-controlled environment
 * variable to the release-state file adapter. Read exactly once, only when
 * main() runs; undefined or "" means no adapter (the tool then reports
 * UNAVAILABLE). No trimming, no coercion, no dynamic reload, no generic env
 * reader is exposed anywhere; the configured value is never echoed. Any
 * non-empty value is validated by createReleaseStateFileAdapter, which
 * throws at construction on an invalid operator path.
 */
export function createApplicationDeploymentAdapterFromEnvironment(
  read: (name: string) => string | undefined = (name) => process.env[name],
): ApplicationDeploymentAdapter | null {
  const configured = read(RELEASE_STATE_FILE_ENV_VAR);
  if (configured === undefined || configured === "") {
    return null;
  }
  return createReleaseStateFileAdapter({ path: configured });
}

export async function main(): Promise<void> {
  const server = buildServer({
    applicationDeploymentAdapter: createApplicationDeploymentAdapterFromEnvironment(),
    dockerHealthAdapter: createDockerHealthAdapterFromEnvironment(),
    logsEvidenceAdapter: createLogEvidenceAdapterFromEnvironment(),
  });
  await server.connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
