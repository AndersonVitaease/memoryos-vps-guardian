/**
 * Log-evidence file transport (Tool 10, public MVP).
 *
 * Mirrors the proven release-state-file and docker-health-file transport
 * security characteristics for the log-evidence domain: ONE operator-configured
 * local JSON file whose content is one LogEvidence document produced by the
 * operator's own monitoring stack OUTSIDE this MCP process. This is NOT a log
 * reader: no raw logs, no tail, no watch, no directory access, no journal, no
 * container logs — one fixed structured JSON file, nothing else.
 *
 * Boundary of this transport:
 * - The ONLY filesystem capability is statSync() + readFileSync() against the
 *   ONE construction-fixed absolute path. No writes, renames, deletes,
 *   directory listings, globs, watchers, polling, streams, retries or
 *   caching. No process.env access. No clock access.
 * - NO shell, NO SSH, NO child_process, NO journalctl, NO docker logs, NO
 *   Docker socket, NO network. The path authority lives entirely with the
 *   operator at construction time; the MCP agent can never supply or change
 *   the path, and no MCP tool arguments carry evidence.
 * - Read-only and fail-closed: every runtime failure (missing file,
 *   permission denied, directory/non-regular file, oversized file, malformed
 *   JSON, invalid schema) maps deterministically to null, which the contract
 *   already maps to UNAVAILABLE. Nothing is repaired, coerced, defaulted or
 *   fabricated, and validation/file details are never exposed.
 * - Evidence passes through the strict schema (tryParseLogEvidence), so
 *   unknown keys, control characters, over-long strings and malformed
 *   timestamps are rejected.
 *
 * Producer recommendation: write a temporary file, then atomically rename it
 * over this path, so readers never observe a partial write. A partial write
 * anyway fails closed (size-capped garbage fails JSON/schema validation).
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  tryParseLogEvidence,
} from "./logEvidence";
import type {
  LogEvidence,
  LogEvidenceAdapter,
} from "./logEvidence";

/** Hard upper bound for one log-evidence file, checked before and after read. */
export const MAX_LOG_EVIDENCE_BYTES = 65536;

/** Control characters (C0/C1) and DEL are never allowed in a configured path. */
const PATH_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u0080-\u009F]/;

const MIN_PATH_LENGTH = 1;
const MAX_PATH_LENGTH = 4096;

export interface LogEvidenceFileConfig {
  /** The ONE log-evidence file this adapter may read. Operator-controlled, construction-time only. */
  path: string;
}

/**
 * Create the single-purpose log-evidence file adapter.
 *
 * Throws at construction on invalid configuration (wrong type, empty,
 * over-long or control-character-bearing path) so operator misconfiguration
 * fails loudly at startup — never silently per collect() call.
 */
export function createLogEvidenceFileAdapter(
  config: LogEvidenceFileConfig,
): LogEvidenceAdapter {
  const configuredPath = config?.path;
  if (
    typeof configuredPath !== "string" ||
    configuredPath.length < MIN_PATH_LENGTH ||
    configuredPath.length > MAX_PATH_LENGTH
  ) {
    throw new Error(
      `invalid log-evidence-file configuration: path must be a string of ${MIN_PATH_LENGTH}-${MAX_PATH_LENGTH} characters`,
    );
  }
  if (PATH_CONTROL_CHARACTERS.test(configuredPath)) {
    throw new Error("invalid log-evidence-file configuration: path must not contain control characters");
  }

  // Resolved exactly once; collect() can only ever touch this absolute path.
  const absolutePath = resolve(configuredPath);

  return {
    name: "log-evidence-file",
    collect(): LogEvidence | null {
      try {
        const stats = statSync(absolutePath);
        if (!stats.isFile() || stats.size > MAX_LOG_EVIDENCE_BYTES) {
          return null;
        }
      } catch {
        // Missing file, permission denied, or any other stat failure.
        return null;
      }

      let raw: Buffer;
      try {
        raw = readFileSync(absolutePath);
      } catch {
        return null;
      }
      // Defense-in-depth against a file growing between stat and read.
      if (raw.byteLength > MAX_LOG_EVIDENCE_BYTES) {
        return null;
      }

      // UTF-8 only; strip exactly one leading UTF-8 BOM (Windows editors).
      const text = raw.toString("utf8");
      const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

      let parsed: unknown;
      try {
        parsed = JSON.parse(withoutBom);
      } catch {
        return null;
      }

      // Strict contract validation; invalid evidence -> null.
      return tryParseLogEvidence(parsed);
    },
  };
}
