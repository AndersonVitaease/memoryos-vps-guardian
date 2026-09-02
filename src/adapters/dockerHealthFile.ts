/**
 * Docker-health file transport (Tool 08, public MVP).
 *
 * Mirrors the proven release-state-file transport security characteristics
 * for the docker.health evidence domain: ONE operator-configured local JSON
 * file whose content is one DockerHealthEvidence document produced by the
 * operator's own monitoring stack OUTSIDE this MCP process.
 *
 * Boundary of this transport:
 * - The ONLY filesystem capability is statSync() + readFileSync() against the
 *   ONE construction-fixed absolute path. No writes, renames, deletes,
 *   directory listings, globs, watchers, polling, streams, retries or
 *   caching. No process.env access. No clock access.
 * - NO Docker socket, NO Docker Engine API, NO docker CLI, NO child_process,
 *   NO shell, NO network. The path authority lives entirely with the
 *   operator at construction time; the MCP agent can never supply or change
 *   the path, and no MCP tool arguments carry evidence.
 * - Read-only and fail-closed: every runtime failure (missing file,
 *   permission denied, directory/non-regular file, oversized file, malformed
 *   JSON, invalid schema) maps deterministically to null, which the contract
 *   already maps to UNAVAILABLE. Nothing is repaired, coerced, defaulted or
 *   fabricated, and validation/file details are never exposed.
 * - Evidence passes through the strict schema (tryParseDockerHealthEvidence),
 *   so unknown keys, control characters and malformed timestamps are rejected.
 *
 * Producer recommendation: write a temporary file, then atomically rename it
 * over this path, so readers never observe a partial write. A partial write
 * anyway fails closed (size-capped garbage fails JSON/schema validation).
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  tryParseDockerHealthEvidence,
} from "./dockerHealth";
import type {
  DockerHealthAdapter,
  DockerHealthEvidence,
} from "./dockerHealth";

/** Hard upper bound for one docker-health file, checked before and after read. */
export const MAX_DOCKER_HEALTH_BYTES = 65536;

/** Control characters (C0/C1) and DEL are never allowed in a configured path. */
const PATH_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u0080-\u009F]/;

const MIN_PATH_LENGTH = 1;
const MAX_PATH_LENGTH = 4096;

export interface DockerHealthFileConfig {
  /** The ONE docker-health file this adapter may read. Operator-controlled, construction-time only. */
  path: string;
}

/**
 * Create the single-purpose docker-health file adapter.
 *
 * Throws at construction on invalid configuration (wrong type, empty,
 * over-long or control-character-bearing path) so operator misconfiguration
 * fails loudly at startup — never silently per collect() call.
 */
export function createDockerHealthFileAdapter(
  config: DockerHealthFileConfig,
): DockerHealthAdapter {
  const configuredPath = config?.path;
  if (
    typeof configuredPath !== "string" ||
    configuredPath.length < MIN_PATH_LENGTH ||
    configuredPath.length > MAX_PATH_LENGTH
  ) {
    throw new Error(
      `invalid docker-health-file configuration: path must be a string of ${MIN_PATH_LENGTH}-${MAX_PATH_LENGTH} characters`,
    );
  }
  if (PATH_CONTROL_CHARACTERS.test(configuredPath)) {
    throw new Error("invalid docker-health-file configuration: path must not contain control characters");
  }

  // Resolved exactly once; collect() can only ever touch this absolute path.
  const absolutePath = resolve(configuredPath);

  return {
    name: "docker-health-file",
    collect(): DockerHealthEvidence | null {
      try {
        const stats = statSync(absolutePath);
        if (!stats.isFile() || stats.size > MAX_DOCKER_HEALTH_BYTES) {
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
      if (raw.byteLength > MAX_DOCKER_HEALTH_BYTES) {
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
      return tryParseDockerHealthEvidence(parsed);
    },
  };
}
