/**
 * MCP server for MemoryOS VPS Guardian — public MVP.
 *
 * Registers the implemented tools: engineering.vps.health,
 * engineering.vps.capacity and engineering.vps.what_changed (read-only,
 * deterministic). The what_changed instance is created per buildServer() call:
 * its baseline and last observation live only in the memory of this process.
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
import { localSystemHealthAdapter } from "./adapters/systemHealth";

export function buildServer(): McpServer {
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

  return server;
}

export async function main(): Promise<void> {
  const server = buildServer();
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
