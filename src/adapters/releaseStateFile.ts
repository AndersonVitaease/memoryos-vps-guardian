/**
 * Release-state file transport (public MVP).
 *
 * The first evidence source for the published application/deployment safe
 * adapter contract: ONE operator-configured local JSON file whose content is
 * one ApplicationDeploymentEvidence document. The path is fixed at adapter
 * construction time by the host process; the MCP agent can never supply or
 * modify it, and no MCP tool arguments carry evidence.
 *
 * Boundary of this transport:
 * - The ONLY filesystem capability is statSync() + readFileSync() against the
 *   ONE construction-fixed absolute path. No writes, renames, deletes,
 *   directory listings, globs, watchers, polling, streams, retries or
 *   caching. No process.env access. No clock access.
 * - Read-only and fail-closed: every runtime failure (missing file,
 *   permission denied, directory/non-regular file, oversized file, malformed
 *   JSON, invalid schema) maps deterministically to null, which the contract
 *   already maps to UNAVAILABLE. Nothing is repaired, coerced, defaulted or
 *   fabricated, and validation/file details are never exposed.
 * - Evidence passes through the certified strict schema
 *   (tryParseApplicationDeploymentEvidence), so unknown keys, control
 *   characters, malformed/impossible timestamps and inconsistent ordering are
 *   rejected exactly as in the contract.
 * - No staleness computation: observedAt passes through exactly as validated;
 *   staleness display/policy belongs to the future consuming MCP tool.
 * - Provenance: `source` stays required inside the evidence document. The
 *   transport guarantees only the channel (the configured file); it never
 *   injects or fabricates provenance.
 *
 * Producer recommendation: write a temporary file, then atomically rename it
 * over this path, so readers never observe a partial write. A partial write
 * anyway fails closed (size-capped garbage fails JSON/schema validation).
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  tryParseApplicationDeploymentEvidence,
} from "./applicationDeployment";
import type {
  ApplicationDeploymentAdapter,
  ApplicationDeploymentEvidence,
} from "./applicationDeployment";

/** Hard upper bound for one release-state file, checked before and after read. */
export const MAX_RELEASE_STATE_BYTES = 65536;

/** Control characters (C0/C1) and DEL are never allowed in a configured path. */
const PATH_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u0080-\u009F]/;

const MIN_PATH_LENGTH = 1;
const MAX_PATH_LENGTH = 4096;

export interface ReleaseStateFileConfig {
  /** The ONE release-state file this adapter may read. Operator-controlled, construction-time only. */
  path: string;
}

/**
 * Create the single-purpose release-state file adapter.
 *
 * Throws at construction on invalid configuration (wrong type, empty,
 * over-long or control-character-bearing path) so operator misconfiguration
 * fails loudly at startup — never silently per collect() call.
 */
export function createReleaseStateFileAdapter(
  config: ReleaseStateFileConfig,
): ApplicationDeploymentAdapter {
  const configuredPath = config?.path;
  if (
    typeof configuredPath !== "string" ||
    configuredPath.length < MIN_PATH_LENGTH ||
    configuredPath.length > MAX_PATH_LENGTH
  ) {
    throw new Error(
      `invalid release-state-file configuration: path must be a string of ${MIN_PATH_LENGTH}-${MAX_PATH_LENGTH} characters`,
    );
  }
  if (PATH_CONTROL_CHARACTERS.test(configuredPath)) {
    throw new Error("invalid release-state-file configuration: path must not contain control characters");
  }

  // Resolved exactly once; collect() can only ever touch this absolute path.
  const absolutePath = resolve(configuredPath);

  return {
    name: "release-state-file",
    collect(): ApplicationDeploymentEvidence | null {
      try {
        const stats = statSync(absolutePath);
        if (!stats.isFile() || stats.size > MAX_RELEASE_STATE_BYTES) {
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
      if (raw.byteLength > MAX_RELEASE_STATE_BYTES) {
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

      // Certified strict contract validation; invalid evidence -> null.
      return tryParseApplicationDeploymentEvidence(parsed);
    },
  };
}
