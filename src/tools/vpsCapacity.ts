/**
 * engineering.vps.capacity — public MVP tool (read-only, deterministic).
 *
 * Answers one goal: "Is my VPS close to its capacity limits?" based ONLY on the
 * same safe, local, read-only evidence already collected by the shared system
 * health adapter (CPU count, 1-minute load average, total/free memory).
 *
 * Contract:
 * - Input must be exactly {} (no parameters). The strict-empty contract is
 *   enforced at the tool function boundary via the same assertion used by
 *   engineering.vps.health, and at the MCP protocol layer via
 *   z.object({}).strict() (published JSON Schema carries
 *   additionalProperties: false, so extra keys are rejected, never stripped).
 * - No mutation, no shell, no SSH, no LLM, no network access, no filesystem,
 *   no secrets, no dependency on private MemoryOS/ENG-MCP code.
 * - Deterministic classification from injected evidence only.
 * - Missing essential evidence -> UNKNOWN. Values are never fabricated:
 *   unavailable derived fields are null.
 *
 * Deterministic thresholds (same single source of truth as vpsHealth):
 * - CPU pressure HIGH when raw unrounded load per CPU (loadAverage1m / cpuCount)
 *   is strictly above LOAD_PER_CPU_HIGH_THRESHOLD (= 2).
 * - MEMORY pressure HIGH when raw unrounded used percent is strictly above
 *   MEMORY_USED_PERCENT_HIGH_THRESHOLD (= 90).
 * - Global PRESSURED when either component is HIGH; OK when both are OK;
 *   UNKNOWN when essential evidence cannot be obtained (or is inconsistent).
 * - Comparisons use raw values; rounding is display-only.
 *
 * Current state only: the result describes the present snapshot. It never
 * predicts future capacity, never estimates time-to-exhaustion and never
 * recommends upgrades.
 */

import { z } from "zod";
import { localSystemHealthAdapter } from "../adapters/systemHealth";
import type { SystemHealthAdapter, VpsHealthEvidence } from "../adapters/systemHealth";
import {
  assertStrictEmptyInput,
  LOAD_PER_CPU_DEGRADED_THRESHOLD,
  MEMORY_USED_PERCENT_DEGRADED_THRESHOLD,
  StrictInputError,
} from "./vpsHealth";

/** CPU pressure is HIGH when raw load per CPU is strictly above this value. Shared with engineering.vps.health. */
export const LOAD_PER_CPU_HIGH_THRESHOLD = LOAD_PER_CPU_DEGRADED_THRESHOLD;
/** Memory pressure is HIGH when raw used percent is strictly above this value. Shared with engineering.vps.health. */
export const MEMORY_USED_PERCENT_HIGH_THRESHOLD = MEMORY_USED_PERCENT_DEGRADED_THRESHOLD;

export type CapacityPressure = "OK" | "HIGH" | "UNKNOWN";
export type VpsCapacityStatus = "OK" | "PRESSURED" | "UNKNOWN";

export interface VpsCapacityResult {
  status: VpsCapacityStatus;
  summary: string;
  capacity: {
    cpu: {
      cpuCount: number | null;
      loadAverage1m: number | null;
      loadPerCpu: number | null;
      pressure: CapacityPressure;
    };
    memory: {
      totalBytes: number | null;
      freeBytes: number | null;
      usedPercent: number | null;
      pressure: CapacityPressure;
    };
  };
}

export const vpsCapacityOutputSchema = z.object({
  status: z.enum(["OK", "PRESSURED", "UNKNOWN"]),
  summary: z.string(),
  capacity: z.object({
    cpu: z.object({
      cpuCount: z.number().nullable(),
      loadAverage1m: z.number().nullable(),
      loadPerCpu: z.number().nullable(),
      pressure: z.enum(["OK", "HIGH", "UNKNOWN"]),
    }),
    memory: z.object({
      totalBytes: z.number().nullable(),
      freeBytes: z.number().nullable(),
      usedPercent: z.number().nullable(),
      pressure: z.enum(["OK", "HIGH", "UNKNOWN"]),
    }),
  }),
});

export { StrictInputError };

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function assessVpsCapacity(evidence: VpsHealthEvidence): VpsCapacityResult {
  // CPU component: UNKNOWN when cpu/load evidence is missing or unusable.
  let cpuPressure: CapacityPressure = "UNKNOWN";
  let loadPerCpu: number | null = null;
  let cpuNote: string;
  if (evidence.cpuCount !== null && evidence.cpuCount > 0 && evidence.loadAverage1m !== null) {
    const rawLoadPerCpu = evidence.loadAverage1m / evidence.cpuCount;
    loadPerCpu = round1(rawLoadPerCpu);
    cpuPressure = rawLoadPerCpu > LOAD_PER_CPU_HIGH_THRESHOLD ? "HIGH" : "OK";
    cpuNote = `cpu ${cpuPressure} (load ${loadPerCpu} per CPU, threshold ${LOAD_PER_CPU_HIGH_THRESHOLD})`;
  } else {
    cpuNote = "cpu UNKNOWN (evidence unavailable)";
  }

  // Memory component: UNKNOWN when memory evidence is missing or inconsistent.
  let memoryPressure: CapacityPressure = "UNKNOWN";
  let usedPercent: number | null = null;
  let memoryNote: string;
  if (
    evidence.memoryTotalBytes !== null &&
    evidence.memoryTotalBytes > 0 &&
    evidence.memoryFreeBytes !== null
  ) {
    if (evidence.memoryFreeBytes > evidence.memoryTotalBytes) {
      memoryNote = "memory UNKNOWN (inconsistent evidence: free > total)";
    } else {
      const rawUsedPercent =
        ((evidence.memoryTotalBytes - evidence.memoryFreeBytes) / evidence.memoryTotalBytes) * 100;
      usedPercent = round1(rawUsedPercent);
      memoryPressure = rawUsedPercent > MEMORY_USED_PERCENT_HIGH_THRESHOLD ? "HIGH" : "OK";
      memoryNote = `memory ${memoryPressure} (${usedPercent}% used, threshold ${MEMORY_USED_PERCENT_HIGH_THRESHOLD}%)`;
    }
  } else {
    memoryNote = "memory UNKNOWN (evidence unavailable)";
  }

  // Global classification: any component UNKNOWN -> global UNKNOWN (safe).
  const status: VpsCapacityStatus =
    cpuPressure === "UNKNOWN" || memoryPressure === "UNKNOWN"
      ? "UNKNOWN"
      : cpuPressure === "HIGH" || memoryPressure === "HIGH"
        ? "PRESSURED"
        : "OK";

  const summary =
    status === "UNKNOWN"
      ? `UNKNOWN: ${cpuNote}; ${memoryNote}`
      : status === "PRESSURED"
        ? `PRESSURED: ${cpuNote}; ${memoryNote}`
        : `OK: ${cpuNote}; ${memoryNote}`;

  return {
    status,
    summary,
    capacity: {
      cpu: {
        cpuCount: evidence.cpuCount,
        loadAverage1m: evidence.loadAverage1m,
        loadPerCpu,
        pressure: cpuPressure,
      },
      memory: {
        totalBytes: evidence.memoryTotalBytes,
        freeBytes: evidence.memoryFreeBytes,
        usedPercent,
        pressure: memoryPressure,
      },
    },
  };
}

export function handleVpsCapacity(
  input: unknown,
  adapter: SystemHealthAdapter = localSystemHealthAdapter,
): VpsCapacityResult {
  assertStrictEmptyInput(input);
  return assessVpsCapacity(adapter.collect());
}
