/**
 * Application/deployment safe adapter contract (public MVP).
 *
 * The smallest typed evidence seam for the planned application/deployment
 * observation goals (engineering.deploy.status, engineering.app.health,
 * engineering.deploy.ready). It mirrors the existing SystemHealthAdapter
 * pattern: one pure, side-effect-free collect() returning a single evidence
 * snapshot, or null when the source is unavailable for this call.
 *
 * Boundary of this contract:
 * - Types, strict validation and the adapter interface ONLY. No transport is
 *   implemented here: no file reads, no sockets, no subprocesses, no
 *   container-runtime access, no environment access, no authentication
 *   material, no persistence, no mutation.
 * - Evidence authority stays outside the agent/tool-call surface: an adapter
 *   is injected at server construction time by the host process; MCP tool
 *   arguments never carry this evidence.
 * - Malformed or inconsistent evidence is never repaired, defaulted or
 *   guessed: strict validation either accepts it exactly as supplied or
 *   rejects it. Rejection/unavailability maps deterministically to null
 *   (UNAVAILABLE semantics for the caller); a missing field inside valid
 *   evidence maps to UNKNOWN semantics.
 *
 * Every nullable field means "the evidence source cannot observe this".
 * Null is preserved as-is and never turned into a guess.
 */
import { z } from "zod";

/**
 * Deployment statuses an evidence source may report. A source that cannot
 * observe the deployment state reports null instead — it is never inferred.
 */
export const APPLICATION_DEPLOYMENT_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "IN_PROGRESS",
  "QUEUED",
] as const;

export type ApplicationDeploymentStatus = (typeof APPLICATION_DEPLOYMENT_STATUSES)[number];

/** C0/C1 control characters and DEL are never allowed in evidence strings. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u0080-\u009F]/;

/** ISO-8601 UTC timestamps only: calendar date, time, optional fraction, ending with a literal Z. */
const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function boundedProvenanceString(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      message: "must not contain control characters",
    });
}

function iso8601UtcTimestamp() {
  return z
    .string()
    .max(40)
    .regex(ISO_8601_UTC_PATTERN, {
      message: "must be an ISO-8601 UTC timestamp of the form 2026-09-02T12:00:00Z",
    })
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "must be a valid calendar date and time",
    });
}

/**
 * Strict schema for one evidence snapshot. Unknown keys are rejected, strings
 * are bounded and control-character free, timestamps are ISO-8601 UTC and
 * semantically valid, and lastDeploymentFinishedAt must not be after
 * observedAt. Nothing is repaired: the evidence passes exactly as supplied
 * or validation fails.
 */
export const applicationDeploymentEvidenceSchema = z
  .object({
    /** Stable application identity as claimed by the evidence source. */
    applicationId: boundedProvenanceString(200),
    /** ISO-8601 UTC instant at which the source observed this evidence. */
    observedAt: iso8601UtcTimestamp(),
    /** Bounded provenance label of the evidence source (e.g. "release-state-file"). */
    source: boundedProvenanceString(100),
    /** Release the source currently reports; null when the source cannot observe it. */
    currentReleaseId: boundedProvenanceString(200).nullable(),
    /** Immediately previous release tracked by the source, if any. */
    previousReleaseId: boundedProvenanceString(200).nullable(),
    /** Reported deployment status, or null when not observable by the source. */
    deploymentStatus: z.enum(APPLICATION_DEPLOYMENT_STATUSES).nullable(),
    /** When the source last observed a deployment finish, if known. */
    lastDeploymentFinishedAt: iso8601UtcTimestamp().nullable(),
    /** Application liveness AS REPORTED by the source; null when not observable. */
    applicationHealthy: z.boolean().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.lastDeploymentFinishedAt !== null) {
      const finishedAt = Date.parse(value.lastDeploymentFinishedAt);
      const observedAt = Date.parse(value.observedAt);
      if (finishedAt > observedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lastDeploymentFinishedAt"],
          message: "lastDeploymentFinishedAt must not be after observedAt",
        });
      }
    }
  });

export type ApplicationDeploymentEvidence = z.infer<typeof applicationDeploymentEvidenceSchema>;

export class ApplicationDeploymentEvidenceError extends Error {
  constructor(message: string) {
    super(`invalid application/deployment evidence: ${message}`);
    this.name = "ApplicationDeploymentEvidenceError";
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Strict deterministic validation: accepts the evidence exactly as supplied
 * or throws ApplicationDeploymentEvidenceError. Never repairs, defaults,
 * coerces or guesses.
 */
export function parseApplicationDeploymentEvidence(input: unknown): ApplicationDeploymentEvidence {
  const result = applicationDeploymentEvidenceSchema.safeParse(input);
  if (!result.success) {
    throw new ApplicationDeploymentEvidenceError(formatIssues(result.error));
  }
  return result.data;
}

/**
 * Non-throwing variant for future transports: invalid, malformed or
 * unavailable evidence maps deterministically to null (UNAVAILABLE for the
 * caller). Never returns partially repaired evidence.
 */
export function tryParseApplicationDeploymentEvidence(
  input: unknown,
): ApplicationDeploymentEvidence | null {
  try {
    return parseApplicationDeploymentEvidence(input);
  } catch {
    return null;
  }
}

/**
 * Minimal adapter interface, analogous to SystemHealthAdapter: one pure,
 * side-effect-free, read-only evidence snapshot per call, or null when the
 * source is unavailable for this call. No transport ships with this
 * contract; implementations are provided by the host process, never by MCP
 * tool arguments.
 */
export interface ApplicationDeploymentAdapter {
  readonly name: string;
  collect(): ApplicationDeploymentEvidence | null;
}
