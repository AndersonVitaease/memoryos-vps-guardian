/**
 * MCP server for MemoryOS VPS Guardian — public MVP.
 *
 * Registers the implemented tools: engineering.vps.health,
 * engineering.vps.capacity, engineering.vps.what_changed,
 * engineering.vps.incident.summary and engineering.deploy.status
 * (read-only, deterministic). The
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
import { localSystemHealthAdapter } from "./adapters/systemHealth";
import { createReleaseStateFileAdapter } from "./adapters/releaseStateFile";
import type { ApplicationDeploymentAdapter } from "./adapters/applicationDeployment";

export interface BuildServerOptions {
  /**
   * Optional construction-time application/deployment evidence source
   * (e.g. the release-state file adapter). When absent (undefined or null),
   * engineering.deploy.status is still registered and truthfully reports
   * UNAVAILABLE. The path authority lives entirely with the operator; the
   * MCP agent can never supply or change it.
   */
  applicationDeploymentAdapter?: ApplicationDeploymentAdapter | null;
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

  return server;
}

/** The single optional startup environment variable for the evidence source. */
export const RELEASE_STATE_FILE_ENV_VAR = "MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE";

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
