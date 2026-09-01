/**
 * engineering.vps.health — public MVP tool (read-only, deterministic).
 *
 * Contract:
 * - Input must be exactly {} (no parameters). This strict-empty contract is
 *   enforced at the tool function boundary and covered by tests. (At the MCP
 *   protocol layer the input schema is z.object({}).strict(): the published
 *   JSON Schema carries additionalProperties: false and extra keys are
 *   rejected instead of being silently stripped.)
 * - No mutation, no shell, no SSH, no LLM, no network access, no secrets,
 *   no dependency on private MemoryOS/ENG-MCP code.
 * - Deterministic classification from injected evidence only.
 * - Missing essential evidence -> UNKNOWN. Values are never fabricated:
 *   evidence fields are null when unavailable.
 *
 * Deterministic thresholds (documented here, single source of truth):
 * - DEGRADED when memory used percent > MEMORY_USED_PERCENT_DEGRADED_THRESHOLD
 * - DEGRADED when raw unrounded load per CPU (loadAverage1m / cpuCount) is strictly above LOAD_PER_CPU_DEGRADED_THRESHOLD
 * - HEALTHY when neither condition holds
 * - UNKNOWN only when essential evidence cannot be obtained (or is inconsistent)
 */

import { z } from "zod";
import { localSystemHealthAdapter } from "../adapters/systemHealth";
import type { SystemHealthAdapter, VpsHealthEvidence } from "../adapters/systemHealth";

export type VpsHealthStatus = "HEALTHY" | "DEGRADED" | "UNKNOWN";

/** DEGRADED when memory used percent is strictly above this value. */
export const MEMORY_USED_PERCENT_DEGRADED_THRESHOLD = 90;
/** DEGRADED when 1-minute load average per CPU is strictly above this value. */
export const LOAD_PER_CPU_DEGRADED_THRESHOLD = 2;

export interface VpsHealthResult {
  status: VpsHealthStatus;
  summary: string;
  evidence: {
    uptimeSeconds: number | null;
    cpuCount: number | null;
    loadAverage1m: number | null;
    memoryTotalBytes: number | null;
    memoryFreeBytes: number | null;
    memoryUsedPercent: number | null;
  };
}

export const vpsHealthOutputSchema = z.object({
  status: z.enum(["HEALTHY", "DEGRADED", "UNKNOWN"]),
  summary: z.string(),
  evidence: z.object({
    uptimeSeconds: z.number().nullable(),
    cpuCount: z.number().nullable(),
    loadAverage1m: z.number().nullable(),
    memoryTotalBytes: z.number().nullable(),
    memoryFreeBytes: z.number().nullable(),
    memoryUsedPercent: z.number().nullable(),
  }),
});

export class StrictInputError extends Error {
  constructor() {
    super("input must be exactly {} (no parameters)");
    this.name = "StrictInputError";
  }
}

export function assertStrictEmptyInput(input: unknown): void {
  if (input === undefined || input === null) return;
  if (
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 0
  ) {
    throw new StrictInputError();
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function assessVpsHealth(evidence: VpsHealthEvidence): VpsHealthResult {
  const missing: string[] = [];
  if (evidence.uptimeSeconds === null) missing.push("uptimeSeconds");
  if (evidence.cpuCount === null || evidence.cpuCount <= 0) missing.push("cpuCount");
  if (evidence.loadAverage1m === null) missing.push("loadAverage1m");
  if (evidence.memoryTotalBytes === null || evidence.memoryTotalBytes <= 0) missing.push("memoryTotalBytes");
  if (evidence.memoryFreeBytes === null) missing.push("memoryFreeBytes");

  const base: VpsHealthResult["evidence"] = {
    uptimeSeconds: evidence.uptimeSeconds,
    cpuCount: evidence.cpuCount,
    loadAverage1m: evidence.loadAverage1m,
    memoryTotalBytes: evidence.memoryTotalBytes,
    memoryFreeBytes: evidence.memoryFreeBytes,
    memoryUsedPercent: null,
  };

  if (missing.length > 0) {
    return {
      status: "UNKNOWN",
      summary: `UNKNOWN: essential evidence unavailable (${missing.join(", ")})`,
      evidence: base,
    };
  }

  const total = evidence.memoryTotalBytes as number;
  const free = evidence.memoryFreeBytes as number;
  const cpuCount = evidence.cpuCount as number;
  const load1m = evidence.loadAverage1m as number;

  if (free > total) {
    return {
      status: "UNKNOWN",
      summary: "UNKNOWN: inconsistent evidence (memoryFreeBytes > memoryTotalBytes)",
      evidence: base,
    };
  }

  const usedPercent = round1(((total - free) / total) * 100);
  const rawLoadPerCpu = load1m / cpuCount;
  const loadPerCpu = round1(rawLoadPerCpu);
  const evidenceOut: VpsHealthResult["evidence"] = { ...base, memoryUsedPercent: usedPercent };

  const reasons: string[] = [];
  if (usedPercent > MEMORY_USED_PERCENT_DEGRADED_THRESHOLD) {
    reasons.push(`high memory pressure: ${usedPercent}% used (threshold ${MEMORY_USED_PERCENT_DEGRADED_THRESHOLD}%)`);
  }
  if (rawLoadPerCpu > LOAD_PER_CPU_DEGRADED_THRESHOLD) {
    reasons.push(`high load: ${loadPerCpu} per CPU (threshold ${LOAD_PER_CPU_DEGRADED_THRESHOLD})`);
  }

  if (reasons.length > 0) {
    return { status: "DEGRADED", summary: `DEGRADED: ${reasons.join("; ")}`, evidence: evidenceOut };
  }

  return {
    status: "HEALTHY",
    summary: `HEALTHY: no memory or load pressure detected (memory ${usedPercent}% used, load ${loadPerCpu} per CPU; thresholds: memory > ${MEMORY_USED_PERCENT_DEGRADED_THRESHOLD}% used, load > ${LOAD_PER_CPU_DEGRADED_THRESHOLD} per CPU)`,
    evidence: evidenceOut,
  };
}

export function handleVpsHealth(
  input: unknown,
  adapter: SystemHealthAdapter = localSystemHealthAdapter,
): VpsHealthResult {
  assertStrictEmptyInput(input);
  return assessVpsHealth(adapter.collect());
}
