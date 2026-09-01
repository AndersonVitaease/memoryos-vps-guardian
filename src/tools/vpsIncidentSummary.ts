/**
 * engineering.vps.incident.summary — public MVP tool (read-only, deterministic).
 *
 * Answers one narrow goal: "What is happening on this VPS right now, according
 * to the local evidence observed by this MCP process?"
 *
 * This is a deterministic COMPOSITION (strategy C), not a fourth evidence
 * implementation:
 * - ONE SystemHealthAdapter.collect() call produces a single coherent snapshot
 *   that is passed to the existing pure assessVpsHealth() and assessVpsCapacity()
 *   functions (no threshold duplication, no second collection for health/capacity).
 * - The SAME session-scoped what_changed instance given to this factory performs
 *   ONE real observation per summary call. Calling engineering.vps.incident.summary
 *   therefore advances the shared change-observation history exactly like a direct
 *   engineering.vps.what_changed call (documented semantics; no peek API, no
 *   parallel history).
 *
 * Honesty rules:
 * - Overall precedence: UNKNOWN > ATTENTION > NORMAL.
 * - UNKNOWN: any component reported UNKNOWN (essential evidence unavailable,
 *   invalid or inconsistent). Absence of evidence never becomes NORMAL/ATTENTION.
 * - ATTENTION: health DEGRADED, capacity PRESSURED or change CHANGED — meaning
 *   only "one or more currently observed conditions require attention".
 * - NORMAL: health HEALTHY and capacity OK and change NO_CHANGE or
 *   BASELINE_CREATED. BASELINE_CREATED is not an incident, not a change and not
 *   proof of past stability; the limitations state that change observation
 *   started with this call.
 * - No causal inference: no rootCause/cause/causedBy/diagnosis fields and no
 *   causal narratives. Applications, services, containers, deployments and logs
 *   are NOT observed by this tool.
 *
 * Contract: input must be exactly {} (same shared assertion and
 * z.object({}).strict() protocol enforcement as the other tools). No new
 * evidence source, no new adapter, no mutation, no shell, no SSH, no LLM, no
 * network, no filesystem, no persistence, no secrets, no private dependencies.
 */

import { z } from "zod";
import { localSystemHealthAdapter } from "../adapters/systemHealth";
import type { SystemHealthAdapter } from "../adapters/systemHealth";
import { assessVpsHealth, assertStrictEmptyInput } from "./vpsHealth";
import { assessVpsCapacity } from "./vpsCapacity";
import type { VpsWhatChangedToolInstance } from "./vpsWhatChanged";

export type VpsIncidentSummaryStatus = "NORMAL" | "ATTENTION" | "UNKNOWN";

export interface VpsIncidentSummaryObservation {
  source: "engineering.vps.health" | "engineering.vps.capacity" | "engineering.vps.what_changed";
  status: string;
  note: string;
}

export interface VpsIncidentSummaryResult {
  status: VpsIncidentSummaryStatus;
  summary: string;
  observations: VpsIncidentSummaryObservation[];
  limitations: string[];
}

export const vpsIncidentSummaryOutputSchema = z.object({
  status: z.enum(["NORMAL", "ATTENTION", "UNKNOWN"]),
  summary: z.string(),
  observations: z.array(
    z.object({
      source: z.enum([
        "engineering.vps.health",
        "engineering.vps.capacity",
        "engineering.vps.what_changed",
      ]),
      status: z.string(),
      note: z.string(),
    }),
  ),
  limitations: z.array(z.string()),
});

const BASE_LIMITATIONS: readonly string[] = [
  "Change observation is scoped to this MCP process/session; restarting the server resets the change history.",
  "Facts before the current change-observation baseline are unknown.",
  "Applications, services, containers, deployments and logs are not observed by this tool.",
  "No causal conclusion is made from the observed evidence.",
];

const HEALTH_NOTES: Record<string, string> = {
  HEALTHY: "Current VPS health evidence is healthy.",
  DEGRADED: "Current VPS health evidence shows degraded conditions.",
  UNKNOWN: "Current VPS health evidence is unavailable or inconsistent.",
};

const CAPACITY_NOTES: Record<string, string> = {
  OK: "Current resource capacity is within observed limits.",
  PRESSURED: "Current resource capacity is under pressure.",
  UNKNOWN: "Current resource capacity evidence is unavailable or inconsistent.",
};

function changeNote(status: string, changeCount: number): string {
  if (status === "BASELINE_CREATED") return "Change observation baseline was created with this call.";
  if (status === "NO_CHANGE") return "No significant change observed since the previous observation of this process.";
  if (status === "CHANGED") return `Observed ${changeCount} significant change(s) since the previous observation of this process.`;
  return "Change evidence is unavailable or inconsistent.";
}

export interface VpsIncidentSummaryToolInstance {
  readonly name: "engineering.vps.incident.summary";
  /** Handle one tool call. Composition only; owns no state of its own. */
  handle(input: unknown): VpsIncidentSummaryResult;
}

export function createVpsIncidentSummaryTool(
  adapter: SystemHealthAdapter = localSystemHealthAdapter,
  whatChangedTool: VpsWhatChangedToolInstance,
): VpsIncidentSummaryToolInstance {
  function handle(input: unknown): VpsIncidentSummaryResult {
    assertStrictEmptyInput(input);

    // Strategy C: one coherent snapshot for both health and capacity.
    const evidence = adapter.collect();
    const health = assessVpsHealth(evidence);
    const capacity = assessVpsCapacity(evidence);

    // Shared session history: this summary call is one real what_changed observation.
    const change = whatChangedTool.handle({});

    const observations: VpsIncidentSummaryObservation[] = [
      { source: "engineering.vps.health", status: health.status, note: HEALTH_NOTES[health.status] },
      { source: "engineering.vps.capacity", status: capacity.status, note: CAPACITY_NOTES[capacity.status] },
      {
        source: "engineering.vps.what_changed",
        status: change.status,
        note: changeNote(change.status, change.changes.length),
      },
    ];

    const limitations =
      change.status === "BASELINE_CREATED"
        ? [...BASE_LIMITATIONS, "Change observation started with this call; nothing before this baseline is known."]
        : [...BASE_LIMITATIONS];

    const componentStatuses = [health.status, capacity.status, change.status];
    let status: VpsIncidentSummaryStatus;
    let summary: string;
    if (componentStatuses.includes("UNKNOWN")) {
      status = "UNKNOWN";
      summary =
        "Current VPS state cannot be summarized reliably because some required evidence is unavailable.";
    } else if (
      health.status === "DEGRADED" ||
      capacity.status === "PRESSURED" ||
      change.status === "CHANGED"
    ) {
      status = "ATTENTION";
      summary = "One or more currently observed conditions require attention.";
    } else {
      status = "NORMAL";
      summary = "Current local VPS evidence appears normal.";
    }

    return { status, summary, observations, limitations };
  }

  return { name: "engineering.vps.incident.summary", handle };
}
