/**
 * Log evidence contract (Tool 10, public MVP).
 *
 * Third evidence domain in the certified adapter style: ONE operator-configured
 * source (see logEvidenceFile.ts) produces ONE strict LogEvidence document per
 * collect() call. The document contains ONLY already-normalized, already-
 * sanitized operational log SIGNALS produced by the operator's own monitoring
 * stack OUTSIDE this MCP process — never a raw log stream.
 *
 * Boundary of this contract:
 * - Bounded: at most MAX_LOG_EVIDENCE_ENTRIES entries; every string is
 *   length-bounded and rejected when it contains control characters.
 * - No arbitrary nested objects: entries carry exactly timestamp, severity,
 *   code and message — nothing else.
 * - No secrets by design: producers must not place environment variables,
 *   headers, request bodies, credentials, tokens, cookies, authorization
 *   values, host paths or stack traces in these fields. The consuming tool
 *   additionally never returns entry messages at all.
 * - No I/O here: this module is types + strict validation + the adapter
 *   interface ONLY, exactly like the docker-health contract.
 * - Strict validation, no repair, no defaulting: malformed, oversized or
 *   unknown-shaped evidence fails closed (tryParseLogEvidence returns null,
 *   which the consuming tool maps to UNAVAILABLE).
 * - Provenance: `source` and `observedAt` are required inside the document;
 *   the transport never injects or fabricates them.
 */
import { z } from "zod";

/** Control characters (C0/C1) and DEL are never valid evidence text. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u0080-\u009F]/;

/** Hard upper bound for the number of normalized log signal entries. */
export const MAX_LOG_EVIDENCE_ENTRIES = 100;

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

const severitySchema = z.enum(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);

const codeSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "control characters are not allowed")
  .refine((value) => value.trim().length > 0, "code must not be blank");

const messageSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "control characters are not allowed");

const entrySchema = z
  .object({
    /** When the producer observed this signal (ISO-8601 UTC, ends in Z); null when not reported. */
    timestamp: observedAtSchema.nullable(),
    /** Producer-assigned severity, preserved verbatim by the consuming tool. */
    severity: severitySchema,
    /** Producer-supplied structured code — the PREFERRED classification input. */
    code: codeSchema.nullable(),
    /** Short producer-sanitized message; classification input only, never returned by the tool. */
    message: messageSchema.nullable(),
  })
  .strict();

export const logEvidenceSchema = z
  .object({
    /** When the operator's evidence producer observed this batch (ISO-8601 UTC, ends in Z). */
    observedAt: observedAtSchema,
    /** What produced the evidence (operator-declared, never fabricated by this server). */
    source: sourceSchema,
    /** Normalized log signals, oldest or most relevant first; bounded count. */
    entries: z.array(entrySchema).max(MAX_LOG_EVIDENCE_ENTRIES),
  })
  .strict();

export type LogEvidence = z.infer<typeof logEvidenceSchema>;
export type LogEvidenceEntry = z.infer<typeof entrySchema>;
export type LogEvidenceSeverity = z.infer<typeof severitySchema>;

export interface LogEvidenceAdapter {
  readonly name: string;
  /**
   * Collect one evidence snapshot. Returns null when no valid evidence is
   * available (missing/unreadable/malformed/oversized source) — never throws,
   * never fabricates, never repairs.
   */
  collect(): LogEvidence | null;
}

/**
 * Strict validation entry point used by transports. Invalid documents map
 * deterministically to null (fail closed); validation details are never
 * exposed to callers or MCP clients.
 */
export function tryParseLogEvidence(value: unknown): LogEvidence | null {
  const parsed = logEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
