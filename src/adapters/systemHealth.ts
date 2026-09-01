/**
 * Local read-only system evidence adapter (public MVP).
 *
 * Collects ONLY safe, read-only evidence from the local Node.js runtime:
 * os.uptime(), os.cpus().length, os.loadavg(), os.totalmem(), os.freemem().
 *
 * Never reads: arbitrary files, environment secrets, credentials, SSH config,
 * tokens, the Docker socket, or any sensitive filesystem path.
 * Executes no external commands. No network access. No mutation.
 *
 * Platform note: on Windows, Node.js os.loadavg() always returns [0, 0, 0].
 * That value is reported as-is: deterministic evidence, never fabricated.
 */
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";

export interface VpsHealthEvidence {
  uptimeSeconds: number | null;
  cpuCount: number | null;
  loadAverage1m: number | null;
  memoryTotalBytes: number | null;
  memoryFreeBytes: number | null;
}

export interface SystemHealthAdapter {
  readonly name: string;
  /** Collect one read-only evidence snapshot. Must be pure and side-effect free. */
  collect(): VpsHealthEvidence;
}

function tryOrNull<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export const localSystemHealthAdapter: SystemHealthAdapter = {
  name: "local-node-os",
  collect(): VpsHealthEvidence {
    return {
      uptimeSeconds: tryOrNull(() => uptime()),
      cpuCount: tryOrNull(() => cpus().length),
      loadAverage1m: tryOrNull(() => loadavg()[0]),
      memoryTotalBytes: tryOrNull(() => totalmem()),
      memoryFreeBytes: tryOrNull(() => freemem()),
    };
  },
};
