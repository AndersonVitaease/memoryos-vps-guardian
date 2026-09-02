/**
 * Docker health evidence contract (Tool 08, public MVP).
 *
 * Second evidence domain in the certified adapter style: ONE operator-configured
 * source (see dockerHealthFile.ts) produces ONE strict DockerHealthEvidence
 * document per collect() call. The evidence contains ONLY normalized aggregate
 * operational facts about the operator's configured container workload.
 *
 * Boundary of this contract:
 * - No container names, IDs, images, labels, mounts, environment variables,
 *   commands, entrypoints, host paths, socket paths, credentials, tokens or
 *   any raw Docker inspect data. Aggregated counts only.
 * - No container-runtime access here: this module performs no I/O at all.
 *   It is types + strict validation + the adapter interface ONLY, exactly
 *   like the application/deployment contract.
 * - Strict validation, no repair, no defaulting: malformed or incomplete
 *   evidence fails closed (tryParseDockerHealthEvidence returns null, which
 *   the consuming tool maps to UNAVAILABLE).
 * - Provenance: `source` is required inside the document; the transport
 *   never injects or fabricates it.
 */
import { z } from "zod";

/** Control characters (C0/C1) and DEL are never valid evidence text. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u0080-\u009F]/;

/** Non-negative integer, or null when the evidence producer could not report it. */
const nullableCount = z
  .number()
  .int()
  .min(0)
  .nullable();

const observedAtSchema = z
  .string()
  .refine((value) => !CONTROL_CHARACTERS.test(value), "control characters are not allowed")
  .refine(
    (value) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/.test(value)
      && !Number.isNaN(Date.parse(value)),
    "observedAt must be an ISO-8601 UTC instant ending in Z",
  );

const sourceSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "control characters are not allowed");

export const dockerHealthEvidenceSchema = z
  .object({
    /** Whether the evidence source reports the container runtime as reachable. */
    runtimeAvailable: z.boolean().nullable(),
    /** When the operator's evidence producer observed this state (ISO-8601 UTC, ends in Z). */
    observedAt: observedAtSchema,
    /** What produced the evidence (operator-declared, never fabricated by this server). */
    source: sourceSchema,
    /** Aggregate counts over the operator's configured/relevant containers only. */
    containers: z
      .object({
        total: nullableCount,
        running: nullableCount,
        unhealthy: nullableCount,
        restarting: nullableCount,
        stopped: nullableCount,
        /** Containers whose state the evidence producer could not determine. */
        unknown: nullableCount,
      })
      .strict(),
  })
  .strict();

export type DockerHealthEvidence = z.infer<typeof dockerHealthEvidenceSchema>;

export interface DockerHealthAdapter {
  readonly name: string;
  /**
   * Collect one evidence snapshot. Returns null when no valid evidence is
   * available (missing/unreadable/malformed source) — never throws, never
   * fabricates, never repairs.
   */
  collect(): DockerHealthEvidence | null;
}

/**
 * Strict validation entry point used by transports. Invalid documents map
 * deterministically to null (fail closed); validation details are never
 * exposed to callers or MCP clients.
 */
export function tryParseDockerHealthEvidence(value: unknown): DockerHealthEvidence | null {
  const parsed = dockerHealthEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
