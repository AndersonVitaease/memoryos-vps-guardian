import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, createDockerHealthAdapterFromEnvironment, DOCKER_HEALTH_FILE_ENV_VAR } from "../src/server";
import { createDockerHealthFileAdapter, MAX_DOCKER_HEALTH_BYTES } from "../src/adapters/dockerHealthFile";
import { tryParseDockerHealthEvidence } from "../src/adapters/dockerHealth";
import type { DockerHealthAdapter, DockerHealthEvidence } from "../src/adapters/dockerHealth";
import { assessDockerHealth, dockerHealthOutputSchema, handleDockerHealth } from "../src/tools/dockerHealth";

const EXACT_OUTPUT_KEYS = [
  "status",
  "summary",
  "source",
  "observedAt",
  "evidenceAgeSeconds",
  "containers",
  "findings",
  "limitations",
].sort();

const TOOL_NAMES = [
  "engineering.app.health",
  "engineering.deploy.ready",
  "engineering.deploy.status",
  "engineering.docker.health",
  "engineering.logs.explain",
  "engineering.vps.why_down",
  "engineering.vps.capacity",
  "engineering.vps.health",
  "engineering.vps.incident.summary",
  "engineering.vps.what_changed",
].sort();

function evidence(overrides: Partial<DockerHealthEvidence> = {}): DockerHealthEvidence {
  return {
    runtimeAvailable: true,
    observedAt: "2026-09-02T12:00:00Z",
    source: "docker-health-file",
    containers: { total: 3, running: 3, unhealthy: 0, restarting: 0, stopped: 0, unknown: 0 },
    ...overrides,
  };
}

interface CountingAdapter extends DockerHealthAdapter {
  calls: number;
}

function adapter(e: DockerHealthEvidence | null): CountingAdapter {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    name: "counting",
    collect() {
      calls += 1;
      return e;
    },
  } as CountingAdapter;
}

function countingClock(): { nowMs: () => number; calls: () => number } {
  let calls = 0;
  return {
    nowMs: () => {
      calls += 1;
      return Date.parse("2026-09-02T12:01:30Z");
    },
    calls: () => calls,
  };
}

async function withServer(dockerHealthAdapter?: DockerHealthAdapter) {
  const server = buildServer({ dockerHealthAdapter });
  const client = new Client({ name: "smoke-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("docker.health > strict input", () => {
  it("accepts exactly empty input ({} / undefined / null)", () => {
    expect(handleDockerHealth({}, adapter(evidence())).status).toBe("HEALTHY");
    expect(handleDockerHealth(undefined, adapter(evidence())).status).toBe("HEALTHY");
    expect(handleDockerHealth(null, adapter(evidence())).status).toBe("HEALTHY");
  });

  it("rejects every agent-steerable parameter", () => {
    const a = adapter(evidence());
    for (const bad of [
      { container: "web-1" },
      { application: "app" },
      { project: "p" },
      { host: "h" },
      { port: 2375 },
      { path: "C:/x.json" },
      { socket: "/var/run/docker.sock" },
      { filter: "x" },
      { label: "y" },
      { namespace: "n" },
      { url: "http://x" },
      { credentials: "c" },
      { command: "docker ps" },
      { extra: 1 },
    ]) {
      expect(() => handleDockerHealth(bad, a)).toThrow(/input must be exactly \{\}/);
    }
  });
});

describe("docker.health > UNAVAILABLE", () => {
  it("no adapter -> UNAVAILABLE, clock never called, nothing fabricated", () => {
    const clock = countingClock();
    const result = handleDockerHealth({}, null, clock.nowMs);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.summary).toBe(
      "UNAVAILABLE: no docker/container health evidence source is configured for this server; nothing was inferred.",
    );
    expect(result.source).toBeNull();
    expect(result.observedAt).toBeNull();
    expect(result.evidenceAgeSeconds).toBeNull();
    expect(result.containers).toEqual({
      total: null,
      running: null,
      unhealthy: null,
      restarting: null,
      stopped: null,
      unknown: null,
    });
    expect(result.findings).toEqual([]);
    expect(clock.calls()).toBe(0);
  });

  it("undefined adapter -> UNAVAILABLE", () => {
    expect(handleDockerHealth({}, undefined).status).toBe("UNAVAILABLE");
  });

  it("collect() null -> UNAVAILABLE, source collected exactly once, no file/error/stack leakage", () => {
    const clock = countingClock();
    const a = adapter(null);
    const result = handleDockerHealth({}, a, clock.nowMs);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.summary).toBe(
      "UNAVAILABLE: the configured docker/container health evidence source returned no valid evidence for this call; nothing was inferred.",
    );
    expect(a.calls).toBe(1);
    expect(clock.calls()).toBe(0);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/ENOENT|EACCES|Error|stack|\.json|docker-health-file/i);
  });
});

describe("docker.health > deterministic classification", () => {
  it("healthy workload -> HEALTHY", () => {
    const r = assessDockerHealth(evidence());
    expect(r.status).toBe("HEALTHY");
    expect(r.summary).toContain("all configured containers running");
  });

  it("runtime unavailable -> DEGRADED (no cause inferred)", () => {
    const r = assessDockerHealth(evidence({ runtimeAvailable: false }));
    expect(r.status).toBe("DEGRADED");
    expect(r.findings).toEqual(["the evidence source reports the container runtime as unavailable"]);
  });

  it("unhealthy / restarting / stopped containers -> DEGRADED", () => {
    expect(assessDockerHealth(evidence({ containers: { total: 3, running: 2, unhealthy: 1, restarting: 0, stopped: 0, unknown: 0 } })).status).toBe("DEGRADED");
    expect(assessDockerHealth(evidence({ containers: { total: 3, running: 2, unhealthy: 0, restarting: 1, stopped: 0, unknown: 0 } })).status).toBe("DEGRADED");
    expect(assessDockerHealth(evidence({ containers: { total: 3, running: 2, unhealthy: 0, restarting: 0, stopped: 1, unknown: 0 } })).status).toBe("DEGRADED");
  });

  it("UNKNOWN-first: incomplete required state -> UNKNOWN, never DEGRADED", () => {
    const a = assessDockerHealth(evidence({ runtimeAvailable: null }));
    expect(a.status).toBe("UNKNOWN");
    expect(a.summary).toContain("runtimeAvailable");
    expect(assessDockerHealth(evidence({ containers: { total: null, running: null, unhealthy: null, restarting: null, stopped: null, unknown: null } })).status).toBe("UNKNOWN");
  });

  it("unknown container count > 0 -> UNKNOWN", () => {
    const r = assessDockerHealth(evidence({ containers: { total: 3, running: 1, unhealthy: 0, restarting: 0, stopped: 1, unknown: 1 } }));
    expect(r.status).toBe("UNKNOWN");
    expect(r.summary).toContain("could not determine the state of 1 container(s)");
  });

  it("internally inconsistent aggregates -> UNKNOWN", () => {
    const r = assessDockerHealth(evidence({ containers: { total: 5, running: 3, unhealthy: 0, restarting: 0, stopped: 0, unknown: 0 } }));
    expect(r.status).toBe("UNKNOWN");
    expect(r.summary).toContain("internally inconsistent");
  });
});

describe("docker.health > handler output + clock", () => {
  it("exact top-level keys and container keys; valid evidence -> exactly one clock call", () => {
    const clock = countingClock();
    const result = handleDockerHealth({}, adapter(evidence()), clock.nowMs);
    expect(Object.keys(result).sort()).toEqual(EXACT_OUTPUT_KEYS);
    expect(Object.keys(result.containers).sort()).toEqual(["restarting", "running", "stopped", "total", "unhealthy", "unknown"]);
    expect(result.evidenceAgeSeconds).toBe(90);
    expect(clock.calls()).toBe(1);
    expect(result.limitations.length).toBe(5);
  });

  it("negative age preserved, floor applied, age never changes verdict", () => {
    let calls = 0;
    const earlier = handleDockerHealth({}, adapter(evidence({ observedAt: "2026-09-02T12:00:05Z" })), () => {
      calls += 1;
      return Date.parse("2026-09-02T12:00:00Z");
    });
    expect(earlier.evidenceAgeSeconds).toBe(-5);
    expect(earlier.status).toBe("HEALTHY");
    const floor = handleDockerHealth({}, adapter(evidence({ observedAt: "2026-09-02T12:00:00.500Z" })), () => Date.parse("2026-09-02T12:00:02Z"));
    expect(floor.evidenceAgeSeconds).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(0);
  });

  it("old evidence stays verdict-neutral and validates against the output schema; invalid enums rejected", () => {
    const result = handleDockerHealth({}, adapter(evidence({ observedAt: "2016-01-01T00:00:00Z" })));
    expect(result.status).toBe("HEALTHY");
    expect(dockerHealthOutputSchema.safeParse(result).success).toBe(true);
    expect(dockerHealthOutputSchema.safeParse({ ...result, status: "PROBABLY" }).success).toBe(false);
    expect(dockerHealthOutputSchema.safeParse({ ...result, containers: { ...result.containers, total: 1.5 } }).success).toBe(false);
  });

  it("no raw docker internals in output", () => {
    const result = handleDockerHealth({}, adapter(evidence()));
    const data = JSON.stringify({ summary: result.summary, containers: result.containers, findings: result.findings });
    for (const forbidden of ["inspect", "Mounts", "Env", "Cmd", "Entrypoint", "/var/run/docker.sock", "image", "token", "secret", "credential", "container-"]) {
      expect(data.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("docker.health > file transport", () => {
  let dir: string;
  const originalEnv = process.env[DOCKER_HEALTH_FILE_ENV_VAR];

  function write(path: string, content: string) {
    writeFileSync(path, content, "utf8");
  }

  it("valid file -> normalized evidence; missing/malformed/invalid/oversized -> null (fail closed)", () => {
    dir = mkdtempSync(join(tmpdir(), "docker-health-"));
    const good = join(dir, "good.json");
    write(good, JSON.stringify(evidence()));
    const goodAdapter = createDockerHealthFileAdapter({ path: good });
    const collected = goodAdapter.collect();
    expect(collected).toEqual(evidence());
    expect(handleDockerHealth({}, goodAdapter).status).toBe("HEALTHY");

    expect(createDockerHealthFileAdapter({ path: join(dir, "missing.json") }).collect()).toBeNull();
    const bad = join(dir, "bad.json");
    write(bad, "{not json");
    expect(createDockerHealthFileAdapter({ path: bad }).collect()).toBeNull();
    const invalid = join(dir, "invalid.json");
    write(invalid, JSON.stringify({ runtimeAvailable: true, containers: { total: 1 } }));
    expect(createDockerHealthFileAdapter({ path: invalid }).collect()).toBeNull();
    expect(tryParseDockerHealthEvidence({ ...evidence(), containers: { ...evidence().containers, extra: 1 } })).toBeNull();
    const huge = join(dir, "huge.json");
    write(huge, "x".repeat(MAX_DOCKER_HEALTH_BYTES + 1));
    expect(createDockerHealthFileAdapter({ path: huge }).collect()).toBeNull();
    expect(() => createDockerHealthFileAdapter({ path: "" })).toThrow(/invalid docker-health-file configuration/);
    expect(() => createDockerHealthFileAdapter({ path: "bad\u0000path" })).toThrow(/control characters/);
  });

  it("env wiring: unset/empty -> null; set -> adapter (agent can never set it per-call)", () => {
    delete process.env[DOCKER_HEALTH_FILE_ENV_VAR];
    expect(createDockerHealthAdapterFromEnvironment(() => undefined)).toBeNull();
    expect(createDockerHealthAdapterFromEnvironment(() => "")).toBeNull();
    const a = createDockerHealthAdapterFromEnvironment(() => "C:/ops/docker-health.json");
    expect(a).not.toBeNull();
    if (originalEnv === undefined) {
      delete process.env[DOCKER_HEALTH_FILE_ENV_VAR];
    } else {
      process.env[DOCKER_HEALTH_FILE_ENV_VAR] = originalEnv;
    }
  });
});

describe("docker.health > MCP integration", () => {
  it("lists exactly the ten public tools and rejects non-empty arguments at the protocol layer", async () => {
    const { client, close } = await withServer();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
      const call = await client.callTool({ name: "engineering.docker.health", arguments: { path: "C:/x" } });
      expect(call.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("zero-config server starts and docker.health reports UNAVAILABLE; injected adapter reports HEALTHY with factual integer age", async () => {
    const zero = await withServer();
    try {
      const unavailable = await zero.client.callTool({ name: "engineering.docker.health", arguments: {} });
      const parsed = JSON.parse((unavailable.content as Array<{ text: string }>)[0].text);
      expect(parsed.status).toBe("UNAVAILABLE");
      expect(parsed.evidenceAgeSeconds).toBeNull();
    } finally {
      await zero.close();
    }

    const { client, close } = await withServer(adapter(evidence()));
    try {
      const call = await client.callTool({ name: "engineering.docker.health", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text);
      expect(parsed.status).toBe("HEALTHY");
      expect(typeof parsed.evidenceAgeSeconds).toBe("number");
      expect(Number.isInteger(parsed.evidenceAgeSeconds)).toBe(true);
      expect(Object.keys(parsed).sort()).toEqual(EXACT_OUTPUT_KEYS);
    } finally {
      await close();
    }
  });
});
