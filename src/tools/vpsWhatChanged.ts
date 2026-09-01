/**
 * engineering.vps.what_changed — public MVP tool (read-only, deterministic).
 *
 * Answers one narrow goal: "What changed since the PREVIOUS observation made by
 * THIS MCP process?" It compares the current local OS evidence snapshot against
 * the previous in-memory observation of the same tool instance (one instance
 * per MCP server/session).
 *
 * Scope and honesty rules:
 * - The FIRST successful observation creates the baseline and reports
 *   BASELINE_CREATED with an empty changes list. The tool never claims any
 *   knowledge from before that baseline.
 * - State (baseline + last observation) lives only in the memory of the tool
 *   instance created for this MCP session. There is no persistence, no state
 *   files, no database. Restarting the MCP server resets all history; the next
 *   call creates a fresh baseline.
 * - It does NOT provide and never infers deployment, file, service, container,
 *   configuration or user-action history: no such evidence exists in this MVP.
 * - NO_CHANGE means only: "no observed evidence changed above the documented
 *   thresholds since the previous observation of this process" — never
 *   "nothing changed on the VPS".
 *
 * Contract:
 * - Input must be exactly {} (no parameters), enforced via the same shared
 *   assertion used by engineering.vps.health/capacity and, at the MCP protocol
 *   layer, via z.object({}).strict() (published JSON Schema carries
 *   additionalProperties: false, so extra keys are rejected, never stripped).
 * - Reuses the existing SystemHealthAdapter only (no new evidence source, no
 *   duplicated collection). No mutation, no shell, no SSH, no LLM, no network,
 *   no filesystem, no secrets, no dependency on private MemoryOS/ENG-MCP code.
 * - Missing/invalid/inconsistent essential evidence -> UNKNOWN. The previous
 *   observation is preserved and the observation counter does not advance:
 *   absence of evidence never becomes NO_CHANGE and never fabricates changes.
 *
 * Deterministic significance thresholds (raw unrounded values compared;
 * rounding is display-only):
 * - CPU count differs -> change (category "cpuCount").
 * - Current uptime < previous uptime -> change (category "reboot"). The
 *   description is factual; the cause of the reboot is never claimed.
 * - abs(free memory delta) strictly greater than 1% of memoryTotalBytes ->
 *   change (category "memory"). Exactly 1% is NOT a change. If
 *   memoryTotalBytes itself changed between observations, the memory
 *   component is conservatively skipped (component UNKNOWN, no fabricated
 *   comparison).
 * - abs(load-per-CPU delta) strictly greater than 0.5, where
 *   loadPerCpu = loadAverage1m / cpuCount (raw) -> change (category "cpu").
 *   Exactly 0.5 is NOT a change.
 *
 * observationsSinceBaseline counts successful observations of this instance:
 * first call = 1, second call = 2, and so on. Calls that return UNKNOWN
 * (invalid evidence) neither create nor advance observations.
 */

import { z } from "zod";
import { localSystemHealthAdapter } from "../adapters/systemHealth";
import type { SystemHealthAdapter, VpsHealthEvidence } from "../adapters/systemHealth";
import { assertStrictEmptyInput } from "./vpsHealth";

/** Memory free-bytes delta (absolute) is significant when strictly greater than this fraction of memoryTotalBytes. */
export const MEMORY_FREE_DELTA_FRACTION_THRESHOLD = 0.01;
/** Load-per-CPU delta (absolute, raw) is significant when strictly greater than this value. */
export const LOAD_PER_CPU_DELTA_THRESHOLD = 0.5;

export type VpsWhatChangedStatus = "CHANGED" | "NO_CHANGE" | "BASELINE_CREATED" | "UNKNOWN";
export type VpsWhatChangedCategory = "cpuCount" | "reboot" | "memory" | "cpu";

export interface VpsWhatChangedChange {
  category: VpsWhatChangedCategory;
  description: string;
  before: number;
  after: number;
}

export interface VpsWhatChangedResult {
  status: VpsWhatChangedStatus;
  summary: string;
  /** ISO UTC timestamp of the first successful observation of this session; null while no baseline exists. */
  baselineCapturedAt: string | null;
  observationsSinceBaseline: number;
  changes: VpsWhatChangedChange[];
}

export const vpsWhatChangedOutputSchema = z.object({
  status: z.enum(["CHANGED", "NO_CHANGE", "BASELINE_CREATED", "UNKNOWN"]),
  summary: z.string(),
  baselineCapturedAt: z.string().nullable(),
  observationsSinceBaseline: z.number(),
  changes: z.array(
    z.object({
      category: z.enum(["cpuCount", "reboot", "memory", "cpu"]),
      description: z.string(),
      before: z.number(),
      after: z.number(),
    }),
  ),
});

/** One stored observation (raw values only; no rounding, no derivation). */
interface VpsObservation {
  observedAt: string;
  uptimeSeconds: number;
  cpuCount: number;
  loadAverage1m: number;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
}

/**
 * Essential evidence for a SAFE comparison: every field needed by every diff
 * must be present, usable and internally consistent. Anything less -> UNKNOWN.
 */
function isValidEvidence(evidence: VpsHealthEvidence): boolean {
  return (
    evidence.uptimeSeconds !== null &&
    evidence.cpuCount !== null &&
    evidence.cpuCount > 0 &&
    evidence.loadAverage1m !== null &&
    evidence.memoryTotalBytes !== null &&
    evidence.memoryTotalBytes > 0 &&
    evidence.memoryFreeBytes !== null &&
    evidence.memoryFreeBytes <= evidence.memoryTotalBytes
  );
}

function toObservation(evidence: VpsHealthEvidence, observedAt: string): VpsObservation {
  return {
    observedAt,
    uptimeSeconds: evidence.uptimeSeconds as number,
    cpuCount: evidence.cpuCount as number,
    loadAverage1m: evidence.loadAverage1m as number,
    memoryTotalBytes: evidence.memoryTotalBytes as number,
    memoryFreeBytes: evidence.memoryFreeBytes as number,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface VpsWhatChangedToolInstance {
  readonly name: "engineering.vps.what_changed";
  /** Handle one tool call. State (baseline + last observation) lives in this instance only. */
  handle(input: unknown): VpsWhatChangedResult;
}

/**
 * Create one session-scoped what_changed tool instance. Each instance keeps
 * its own in-memory baseline and previous observation; creating a new instance
 * (e.g. a fresh MCP server session) starts a new baseline and loses history.
 */
export function createVpsWhatChangedTool(
  adapter: SystemHealthAdapter = localSystemHealthAdapter,
): VpsWhatChangedToolInstance {
  let lastObservation: VpsObservation | null = null;
  let baselineCapturedAt: string | null = null;
  let observationsSinceBaseline = 0;

  function handle(input: unknown): VpsWhatChangedResult {
    assertStrictEmptyInput(input);

    const evidence = adapter.collect();

    // Missing/invalid/inconsistent evidence: UNKNOWN. The stored previous
    // observation is kept for the next comparison; nothing is invented and the
    // observation counter does not advance.
    if (!isValidEvidence(evidence)) {
      const summary =
        lastObservation === null
          ? "UNKNOWN: essential evidence unavailable or inconsistent; no baseline observation could be created."
          : "UNKNOWN: essential evidence unavailable or inconsistent; the previous observation was kept for the next comparison.";
      return {
        status: "UNKNOWN",
        summary,
        baselineCapturedAt,
        observationsSinceBaseline,
        changes: [],
      };
    }

    const current = toObservation(evidence, new Date().toISOString());

    // First successful observation of this instance: create the baseline.
    // There is no previous observation, so no change can be reported.
    if (lastObservation === null) {
      lastObservation = current;
      baselineCapturedAt = current.observedAt;
      observationsSinceBaseline = 1;
      return {
        status: "BASELINE_CREATED",
        summary:
          "BASELINE_CREATED: first observation of this MCP process session; no previous observation existed, so nothing could be compared yet. This tool has no knowledge of anything before this baseline.",
        baselineCapturedAt,
        observationsSinceBaseline,
        changes: [],
      };
    }

    // Deterministic diff: previous observation -> current observation (raw values).
    const previous = lastObservation;
    const changes: VpsWhatChangedChange[] = [];

    if (current.cpuCount !== previous.cpuCount) {
      changes.push({
        category: "cpuCount",
        description: `Observed CPU count changed (before ${previous.cpuCount}, after ${current.cpuCount}).`,
        before: previous.cpuCount,
        after: current.cpuCount,
      });
    }

    if (current.uptimeSeconds < previous.uptimeSeconds) {
      changes.push({
        category: "reboot",
        description: `Observed system uptime decreased since the previous observation (before ${previous.uptimeSeconds} s, after ${current.uptimeSeconds} s).`,
        before: previous.uptimeSeconds,
        after: current.uptimeSeconds,
      });
    }

    // Memory: comparable only when memoryTotalBytes is the same in both
    // observations; otherwise the 1%-of-total threshold is not well-defined
    // and the component is conservatively skipped (no fabricated comparison).
    const memoryComparable = previous.memoryTotalBytes === current.memoryTotalBytes;
    if (memoryComparable) {
      const freeDelta = Math.abs(current.memoryFreeBytes - previous.memoryFreeBytes);
      if (freeDelta > MEMORY_FREE_DELTA_FRACTION_THRESHOLD * current.memoryTotalBytes) {
        changes.push({
          category: "memory",
          description: `Observed free memory changed by more than ${MEMORY_FREE_DELTA_FRACTION_THRESHOLD * 100}% of total memory (before ${previous.memoryFreeBytes} bytes free, after ${current.memoryFreeBytes} bytes free).`,
          before: previous.memoryFreeBytes,
          after: current.memoryFreeBytes,
        });
      }
    }

    const previousLoadPerCpu = previous.loadAverage1m / previous.cpuCount;
    const currentLoadPerCpu = current.loadAverage1m / current.cpuCount;
    if (Math.abs(currentLoadPerCpu - previousLoadPerCpu) > LOAD_PER_CPU_DELTA_THRESHOLD) {
      changes.push({
        category: "cpu",
        description: `Observed 1-minute load per CPU changed by more than ${LOAD_PER_CPU_DELTA_THRESHOLD} (before ${round1(previousLoadPerCpu)}, after ${round1(currentLoadPerCpu)}).`,
        before: previousLoadPerCpu,
        after: currentLoadPerCpu,
      });
    }

    // Comparison finished: the current observation becomes the new previous
    // observation (comparison is always previous -> current, never vs the
    // original baseline).
    lastObservation = current;
    observationsSinceBaseline += 1;

    if (changes.length > 0) {
      const memoryNote = memoryComparable
        ? ""
        : " Memory comparison was skipped because memoryTotalBytes changed between observations.";
      return {
        status: "CHANGED",
        summary: `CHANGED: ${changes.length} observable change(s) above the documented thresholds since the previous observation of this process.${memoryNote}`,
        baselineCapturedAt,
        observationsSinceBaseline,
        changes,
      };
    }

    if (!memoryComparable) {
      return {
        status: "UNKNOWN",
        summary:
          "UNKNOWN: memoryTotalBytes changed between observations, so the memory component could not be compared safely; no other change above the documented thresholds was observed since the previous observation of this process.",
        baselineCapturedAt,
        observationsSinceBaseline,
        changes: [],
      };
    }

    return {
      status: "NO_CHANGE",
      summary:
        "NO_CHANGE: no observed evidence changed above the documented thresholds since the previous observation of this process. This does not mean nothing changed on the VPS outside the evidence this tool observes.",
      baselineCapturedAt,
      observationsSinceBaseline,
      changes: [],
    };
  }

  return { name: "engineering.vps.what_changed", handle };
}
