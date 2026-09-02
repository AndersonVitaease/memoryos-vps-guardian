import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../src/server";
import type {
  ApplicationDeploymentAdapter,
  ApplicationDeploymentEvidence,
} from "../src/adapters/applicationDeployment";
import type { DockerHealthAdapter, DockerHealthEvidence } from "../src/adapters/dockerHealth";
import type { SystemHealthAdapter, VpsHealthEvidence } from "../src/adapters/systemHealth";
import { assessWhyDown, handleVpsWhyDown, vpsWhyDownOutputSchema } from "../src/tools/vpsWhyDown";
import type { WhyDownAssessmentInput, WhyDownObservation, WhyDownResult, WhyDownSignalCategory } from "../src/tools/vpsWhyDown";

const EXACT_OUTPUT_KEYS = ["status", "summary", "signals", "limitations"].sort();

const TOOL_NAMES = [
  "engineering.app.health",
  "engineering.deploy.ready",
  "engineering.deploy.status",
  "engineering.docker.health",
  "engineering.logs.explain",
  "engineering.vps.capacity",
  "engineering.vps.health",
  "engineering.vps.incident.summary",
  "engineering.vps.what_changed",
  "engineering.vps.why_down",
].sort();

function systemEvidence(overrides: Partial<VpsHealthEvidence> = {}): VpsHealthEvidence {
  return {
    uptimeSeconds: 1000,
    cpuCount: 2,
    loadAverage1m: 0.5,
    memoryTotalBytes: 8_000_000_000,
    memoryFreeBytes: 4_000_000_000,
    ...overrides,
  };
}

function appEvidence(overrides: Partial<ApplicationDeploymentEvidence> = {}): ApplicationDeploymentEvidence {
  return {
    applicationId: "app-1",
    observedAt: "2026-09-02T12:00:00Z",
    source: "release-state-file",
    currentReleaseId: "r2",
    previousReleaseId: "r1",
    deploymentStatus: "SUCCEEDED",
    lastDeploymentFinishedAt: "2026-09-02T11:00:00Z",
    applicationHealthy: true,
    ...overrides,
  };
}

function dockerEvidence(overrides: Partial<DockerHealthEvidence> = {}): DockerHealthEvidence {
  return {
    runtimeAvailable: true,
    observedAt: "2026-09-02T12:00:00Z",
    source: "docker-health-file",
    containers: { total: 3, running: 3, unhealthy: 0, restarting: 0, stopped: 0, unknown: 0 },
    ...overrides,
  };
}

interface Counting<T> {
  adapter: T;
  calls: () => number;
}

function countingSystem(evidence: VpsHealthEvidence): Counting<SystemHealthAdapter> {
  let calls = 0;
  return {
    adapter: {
      name: "stub-node-os",
      collect() {
        calls += 1;
        return evidence;
      },
    },
    calls: () => calls,
  };
}

function countingApp(evidence: ApplicationDeploymentEvidence | null): Counting<ApplicationDeploymentAdapter> {
  let calls = 0;
  return {
    adapter: {
      name: "stub-release-state",
      collect() {
        calls += 1;
        return evidence;
      },
    } as ApplicationDeploymentAdapter,
    calls: () => calls,
  };
}

function countingDocker(evidence: DockerHealthEvidence | null): Counting<DockerHealthAdapter> {
  let calls = 0;
  return {
    adapter: {
      name: "stub-docker",
      collect() {
        calls += 1;
        return evidence;
      },
    },
    calls: () => calls,
  };
}

function observed(status: string, summary: string, source: string | null = "stub"): WhyDownObservation {
  return { kind: "observed", status, summary, source };
}

function healthyInput(): WhyDownAssessmentInput {
  return {
    VPS_HEALTH: observed("HEALTHY", "HEALTHY: healthy."),
    CAPACITY: observed("OK", "OK: capacity ok."),
    APPLICATION_HEALTH: observed("HEALTHY", "HEALTHY: application healthy."),
    DEPLOYMENT: observed("OK", "OK: deployment succeeded."),
    DOCKER: observed("HEALTHY", "HEALTHY: containers running."),
  };
}

function absentInput(): WhyDownAssessmentInput {
  return {
    VPS_HEALTH: { kind: "absent" },
    CAPACITY: { kind: "absent" },
    APPLICATION_HEALTH: { kind: "absent" },
    DEPLOYMENT: { kind: "absent" },
    DOCKER: { kind: "absent" },
  };
}

function handle(
  sys: SystemHealthAdapter = countingSystem(systemEvidence()).adapter,
  app: ApplicationDeploymentAdapter | null = countingApp(appEvidence()).adapter,
  docker: DockerHealthAdapter | null = countingDocker(dockerEvidence()).adapter,
  input: unknown = {},
): WhyDownResult {
  return handleVpsWhyDown(input, sys, app, docker);
}

function signalOf(result: WhyDownResult, category: WhyDownSignalCategory) {
  const signal = result.signals.find((entry) => entry.category === category);
  expect(signal, `expected a ${category} signal`).toBeDefined();
  return signal as NonNullable<typeof signal>;
}

async function withServer(adapters: { app?: ApplicationDeploymentAdapter; docker?: DockerHealthAdapter } = {}) {
  const server = buildServer({ applicationDeploymentAdapter: adapters.app ?? null, dockerHealthAdapter: adapters.docker ?? null });
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

describe("why_down > strict input", () => {
  it("accepts exactly empty input ({} / undefined / null)", () => {
    expect(handle(undefined, undefined, undefined, {}).status).toBe("HEALTHY");
    expect(handle(undefined, undefined, undefined, undefined).status).toBe("HEALTHY");
    expect(handle(undefined, undefined, undefined, null).status).toBe("HEALTHY");
  });

  it("rejects every agent-steerable parameter", () => {
    for (const bad of [
      { application: "app" },
      { applicationId: "app-1" },
      { project: "p" },
      { host: "h" },
      { ip: "10.0.0.1" },
      { port: 22 },
      { url: "http://x" },
      { container: "web-1" },
      { containerId: "abc" },
      { path: "C:/x.json" },
      { file: "x.json" },
      { service: "s" },
      { process: "p" },
      { command: "docker ps" },
      { query: "q" },
      { filter: "f" },
      { credentials: "c" },
      { token: "t" },
      { target: "t" },
      { extra: 1 },
    ]) {
      expect(() => handle(undefined, undefined, undefined, bad)).toThrow(/input must be exactly \{\}/);
    }
  });
});

describe("why_down > pure synthesis (assessWhyDown)", () => {
  it("all categories absent -> UNAVAILABLE with no signals and nothing inferred", () => {
    const result = assessWhyDown(absentInput());
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.signals).toEqual([]);
    expect(result.summary).toMatch(/^UNAVAILABLE: no evidence source is configured/);
    expect(result.summary).toMatch(/nothing is inferred/);
  });

  it("all observations healthy -> HEALTHY with every signal listed", () => {
    const result = assessWhyDown(healthyInput());
    expect(result.status).toBe("HEALTHY");
    expect(result.signals.map((s) => s.category)).toEqual([
      "VPS_HEALTH",
      "CAPACITY",
      "APPLICATION_HEALTH",
      "DEPLOYMENT",
      "DOCKER",
    ]);
    expect(result.summary).toMatch(/^HEALTHY: all 5 observed signal/);
  });

  it("capacity PRESSURED and VPS DEGRADED are factual problem signals -> DEGRADED with both listed", () => {
    const result = assessWhyDown({
      ...healthyInput(),
      VPS_HEALTH: observed("DEGRADED", "DEGRADED: high memory pressure."),
      CAPACITY: observed("PRESSURED", "PRESSURED: memory under pressure."),
    });
    expect(result.status).toBe("DEGRADED");
    expect(result.summary).toContain("VPS_HEALTH: DEGRADED");
    expect(result.summary).toContain("CAPACITY: PRESSURED");
    expect(result.summary).toMatch(/not a causal diagnosis/);
  });

  it("UNKNOWN-first: any UNKNOWN signal -> overall UNKNOWN even with problem signals present", () => {
    const result = assessWhyDown({
      ...healthyInput(),
      VPS_HEALTH: observed("DEGRADED", "DEGRADED: high memory pressure."),
      APPLICATION_HEALTH: observed("UNKNOWN", "UNKNOWN: applicationHealthy was not reported."),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.summary).toContain("APPLICATION_HEALTH: UNKNOWN");
    expect(result.summary).toContain("VPS_HEALTH: DEGRADED");
    expect(result.summary).toMatch(/no reliable verdict is inferred/);
  });

  it("a configured source returning nothing (UNAVAILABLE) -> overall UNKNOWN, never a failure verdict", () => {
    const result = assessWhyDown({
      ...healthyInput(),
      DOCKER: observed("UNAVAILABLE", "UNAVAILABLE: the configured source returned no evidence.", null),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.summary).toContain("DOCKER: UNAVAILABLE");
  });

  it("deployment FAILED is a problem signal; IN_FLIGHT and PENDING are factual but not problems", () => {
    const failed = assessWhyDown({
      ...healthyInput(),
      DEPLOYMENT: observed("FAILED", "FAILED: the evidence source reports the deployment as FAILED."),
    });
    expect(failed.status).toBe("DEGRADED");
    expect(failed.summary).toContain("DEPLOYMENT: FAILED");

    const inFlight = assessWhyDown({
      ...healthyInput(),
      DEPLOYMENT: observed("IN_FLIGHT", "IN_FLIGHT: the evidence source reports the deployment as IN_PROGRESS."),
    });
    expect(inFlight.status).toBe("HEALTHY");

    const pending = assessWhyDown({
      ...healthyInput(),
      DEPLOYMENT: observed("PENDING", "PENDING: the evidence source reports the deployment as QUEUED."),
    });
    expect(pending.status).toBe("HEALTHY");
  });

  it("repeated calls on identical observations produce identical results", () => {
    expect(assessWhyDown(healthyInput())).toEqual(assessWhyDown(healthyInput()));
    const degraded = { ...healthyInput(), DOCKER: observed("DEGRADED", "DEGRADED: one unhealthy container.") };
    expect(assessWhyDown(degraded)).toEqual(assessWhyDown(degraded));
  });
});

describe("why_down > handler composition", () => {
  it("healthy evidence across all configured sources -> HEALTHY with 5 signals; each adapter collected exactly once", () => {
    const sys = countingSystem(systemEvidence());
    const app = countingApp(appEvidence());
    const docker = countingDocker(dockerEvidence());
    const result = handle(sys.adapter, app.adapter, docker.adapter);

    expect(result.status).toBe("HEALTHY");
    expect(result.signals).toHaveLength(5);
    expect(sys.calls()).toBe(1);
    expect(app.calls()).toBe(1);
    expect(docker.calls()).toBe(1);
    expect(signalOf(result, "VPS_HEALTH").source).toBe("stub-node-os");
    expect(signalOf(result, "APPLICATION_HEALTH").source).toBe("release-state-file");
    expect(signalOf(result, "DOCKER").source).toBe("docker-health-file");
  });

  it("one local snapshot feeds both VPS signals; degraded memory trips VPS_HEALTH and CAPACITY together", () => {
    const sys = countingSystem(systemEvidence({ memoryFreeBytes: 100_000_000 }));
    const result = handle(sys.adapter, null, null);

    expect(result.status).toBe("DEGRADED");
    expect(sys.calls()).toBe(1);
    expect(signalOf(result, "VPS_HEALTH").status).toBe("DEGRADED");
    expect(signalOf(result, "CAPACITY").status).toBe("PRESSURED");
    expect(result.signals).toHaveLength(2);
    expect(result.summary).toContain("VPS_HEALTH: DEGRADED");
    expect(result.summary).toContain("CAPACITY: PRESSURED");
  });

  it("application degraded -> APPLICATION_HEALTH DEGRADED signal while a succeeded deployment stays OK", () => {
    const app = countingApp(appEvidence({ applicationHealthy: false }));
    const result = handle(undefined, app.adapter, undefined);

    expect(result.status).toBe("DEGRADED");
    expect(signalOf(result, "APPLICATION_HEALTH").status).toBe("DEGRADED");
    expect(signalOf(result, "DEPLOYMENT").status).toBe("OK");
    expect(result.summary).toContain("APPLICATION_HEALTH: DEGRADED");
  });

  it("deployment FAILED -> DEPLOYMENT FAILED signal and overall DEGRADED", () => {
    const app = countingApp(appEvidence({ deploymentStatus: "FAILED", applicationHealthy: true }));
    const result = handle(undefined, app.adapter, undefined);

    expect(result.status).toBe("DEGRADED");
    expect(signalOf(result, "DEPLOYMENT").status).toBe("FAILED");
    expect(result.summary).toContain("DEPLOYMENT: FAILED");
  });

  it("deployment IN_FLIGHT is reported factually and does not make the verdict DEGRADED", () => {
    const app = countingApp(appEvidence({ deploymentStatus: "IN_PROGRESS", applicationHealthy: true }));
    const result = handle(undefined, app.adapter, undefined);

    expect(result.status).toBe("HEALTHY");
    expect(signalOf(result, "DEPLOYMENT").status).toBe("IN_FLIGHT");
  });

  it("docker degraded -> DOCKER signal reused from assessDockerHealth, overall DEGRADED", () => {
    const docker = countingDocker(dockerEvidence({ containers: { total: 3, running: 2, unhealthy: 1, restarting: 0, stopped: 0, unknown: 0 } }));
    const result = handle(undefined, undefined, docker.adapter);

    expect(result.status).toBe("DEGRADED");
    const dockerSignal = signalOf(result, "DOCKER");
    expect(dockerSignal.status).toBe("DEGRADED");
    expect(dockerSignal.summary).toMatch(/1 container\(s\) reported unhealthy/);
    expect(dockerSignal.source).toBe("docker-health-file");
  });

  it("docker source configured but returning nothing -> DOCKER UNAVAILABLE signal; that alone never implies failure", () => {
    const docker = countingDocker(null);
    const result = handle(undefined, undefined, docker.adapter);

    expect(result.status).toBe("UNKNOWN");
    expect(signalOf(result, "DOCKER").status).toBe("UNAVAILABLE");
    expect(signalOf(result, "VPS_HEALTH").status).toBe("HEALTHY");
    expect(signalOf(result, "CAPACITY").status).toBe("OK");
    expect(result.status).not.toBe("DEGRADED");
  });

  it("application/deployment source configured but returning nothing -> both signals UNAVAILABLE, overall UNKNOWN", () => {
    const app = countingApp(null);
    const result = handle(undefined, app.adapter, undefined);

    expect(result.status).toBe("UNKNOWN");
    expect(signalOf(result, "APPLICATION_HEALTH").status).toBe("UNAVAILABLE");
    expect(signalOf(result, "DEPLOYMENT").status).toBe("UNAVAILABLE");
    expect(signalOf(result, "VPS_HEALTH").status).toBe("HEALTHY");
  });

  it("sources not configured -> categories absent from signals, never fabricated as causes or health", () => {
    const result = handle(undefined, null, null);

    expect(result.status).toBe("HEALTHY");
    expect(result.signals.map((s) => s.category)).toEqual(["VPS_HEALTH", "CAPACITY"]);
    expect(result.signals.find((s) => s.category === "APPLICATION_HEALTH")).toBeUndefined();
    expect(result.signals.find((s) => s.category === "DEPLOYMENT")).toBeUndefined();
    expect(result.signals.find((s) => s.category === "DOCKER")).toBeUndefined();
    expect(result.limitations.some((line) => line.includes("never read as HEALTHY"))).toBe(true);
  });

  it("ambiguous application evidence (applicationHealthy null) -> UNKNOWN, with any problem signal still reported", () => {
    const app = countingApp(appEvidence({ applicationHealthy: null }));
    const result = handle(undefined, app.adapter, undefined);

    expect(result.status).toBe("UNKNOWN");
    expect(signalOf(result, "APPLICATION_HEALTH").status).toBe("UNKNOWN");
    expect(result.summary).toMatch(/no reliable verdict is inferred/);

    const sys = countingSystem(systemEvidence({ memoryFreeBytes: 100_000_000 }));
    const combined = handle(sys.adapter, app.adapter, undefined);
    expect(combined.status).toBe("UNKNOWN");
    expect(combined.summary).toContain("VPS_HEALTH: DEGRADED");
    expect(combined.summary).toContain("APPLICATION_HEALTH: UNKNOWN");
  });

  it("multiple simultaneous degraded signals are all reported; none is chosen as THE cause", () => {
    const sys = countingSystem(systemEvidence({ memoryFreeBytes: 100_000_000 }));
    const app = countingApp(appEvidence({ applicationHealthy: false }));
    const docker = countingDocker(dockerEvidence({ containers: { total: 3, running: 2, unhealthy: 1, restarting: 0, stopped: 0, unknown: 0 } }));
    const result = handle(sys.adapter, app.adapter, docker.adapter);

    expect(result.status).toBe("DEGRADED");
    expect(result.summary).toContain("VPS_HEALTH: DEGRADED");
    expect(result.summary).toContain("APPLICATION_HEALTH: DEGRADED");
    expect(result.summary).toContain("DOCKER: DEGRADED");
    expect(result.summary).toMatch(/4 signal\(s\) report a degraded or problem condition/);
    expect(result.summary).toMatch(/observed correlation, not a causal diagnosis/);
  });
});

describe("why_down > output hygiene and honesty", () => {
  it("exposes exactly the four output keys; signals carry exactly category/source/status/summary", () => {
    const result = handle();
    expect(Object.keys(result).sort()).toEqual(EXACT_OUTPUT_KEYS);
    for (const signal of result.signals) {
      expect(Object.keys(signal).sort()).toEqual(["category", "source", "status", "summary"]);
    }
  });

  it("contains no root-cause field and no causal connective in summary or signals", () => {
    const result = handle(
      countingSystem(systemEvidence({ memoryFreeBytes: 100_000_000 })).adapter,
      countingApp(appEvidence({ applicationHealthy: false })).adapter,
      countingDocker(dockerEvidence({ containers: { total: 3, running: 2, unhealthy: 1, restarting: 0, stopped: 0, unknown: 0 } })).adapter,
    );
    expect(Object.keys(result).some((key) => /rootcause|cause|diagnosis/i.test(key))).toBe(false);
    const text = JSON.stringify({ summary: result.summary, signals: result.signals }).toLowerCase();
    expect(text).not.toMatch(/because|caused by|due to|rootcause/);
  });

  it("summary and signals carry no raw sensitive or internal evidence", () => {
    const result = handle(
      countingSystem(systemEvidence()).adapter,
      countingApp(appEvidence()).adapter,
      countingDocker(dockerEvidence()).adapter,
    );
    const text = JSON.stringify({ summary: result.summary, signals: result.signals });
    expect(text).not.toMatch(/token|secret|password|credential|docker\.sock|stack|ENOENT|C:\\\\|\.json/i);
    expect(text).not.toMatch(/r2|r1|app-1|total.*3.*running/);
  });

  it("output schema enforces the status and category vocabularies", () => {
    const valid = vpsWhyDownOutputSchema.safeParse(handle());
    expect(valid.success).toBe(true);

    const badStatus = vpsWhyDownOutputSchema.safeParse({
      status: "PROBABLY",
      summary: "s",
      signals: [],
      limitations: [],
    });
    expect(badStatus.success).toBe(false);

    const badCategory = vpsWhyDownOutputSchema.safeParse({
      status: "HEALTHY",
      summary: "s",
      signals: [{ category: "SOMETHING", source: null, status: "HEALTHY", summary: "s" }],
      limitations: [],
    });
    expect(badCategory.success).toBe(false);
  });
});

describe("why_down > MCP layer", () => {
  it("catalog contains engineering.vps.why_down and exactly 10 tools", async () => {
    const { client, close } = await withServer();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      expect(names).toContain("engineering.vps.why_down");
      expect(tools.tools).toHaveLength(10);
    } finally {
      await close();
    }
  });

  it("rejects non-empty arguments at the protocol layer", async () => {
    const { client, close } = await withServer();
    try {
      const call = await client.callTool({ name: "engineering.vps.why_down", arguments: { path: "C:/x" } });
      expect(call.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("zero-config server registers the tool and reports only local VPS signals with unknown optional categories", async () => {
    const { client, close } = await withServer();
    try {
      const call = await client.callTool({ name: "engineering.vps.why_down", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text);
      expect(["HEALTHY", "DEGRADED", "UNKNOWN", "UNAVAILABLE"]).toContain(parsed.status);
      expect(typeof parsed.summary).toBe("string");
      expect(parsed.limitations).toHaveLength(5);
      const categories = parsed.signals.map((signal: { category: string }) => signal.category);
      expect(categories).toContain("VPS_HEALTH");
      expect(categories).toContain("CAPACITY");
      expect(categories).not.toContain("APPLICATION_HEALTH");
      expect(categories).not.toContain("DEPLOYMENT");
      expect(categories).not.toContain("DOCKER");
    } finally {
      await close();
    }
  });

  it("injected adapters flow through the protocol: degraded application + docker -> DEGRADED", async () => {
    const { client, close } = await withServer({
      app: countingApp(appEvidence({ applicationHealthy: false })).adapter,
      docker: countingDocker(dockerEvidence({ containers: { total: 3, running: 2, unhealthy: 1, restarting: 0, stopped: 0, unknown: 0 } })).adapter,
    });
    try {
      const call = await client.callTool({ name: "engineering.vps.why_down", arguments: {} });
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text);
      expect(parsed.status).toBe("DEGRADED");
      expect(parsed.signals).toHaveLength(5);
      const byCategory = Object.fromEntries(parsed.signals.map((signal: { category: string; status: string }) => [signal.category, signal.status]));
      expect(byCategory.APPLICATION_HEALTH).toBe("DEGRADED");
      expect(byCategory.DOCKER).toBe("DEGRADED");
    } finally {
      await close();
    }
  });

  it("repeated MCP calls return identical stub-driven fields (local OS evidence may fluctuate)", async () => {
    const { client, close } = await withServer({
      app: countingApp(appEvidence({ applicationHealthy: false })).adapter,
      docker: countingDocker(dockerEvidence()).adapter,
    });
    try {
      const first = await client.callTool({ name: "engineering.vps.why_down", arguments: {} });
      const second = await client.callTool({ name: "engineering.vps.why_down", arguments: {} });
      const a = JSON.parse((first.content as Array<{ text: string }>)[0].text);
      const b = JSON.parse((second.content as Array<{ text: string }>)[0].text);
      // Fully deterministic at the pure/handler level (covered above); over MCP the
      // real local OS adapter may report slightly different memory between calls,
      // so equality is asserted for the stub-driven and structural fields.
      expect(a.limitations).toEqual(b.limitations);
      expect(a.signals.map((s: { category: string }) => s.category)).toEqual(
        b.signals.map((s: { category: string }) => s.category),
      );
      const stubDriven = (parsed: { signals: Array<{ category: string; status: string; summary: string; source: string | null }> }) =>
        parsed.signals.filter((s) => ["APPLICATION_HEALTH", "DEPLOYMENT", "DOCKER"].includes(s.category));
      expect(stubDriven(a)).toEqual(stubDriven(b));
      expect(a.status).toBe(b.status);
    } finally {
      await close();
    }
  });
});
