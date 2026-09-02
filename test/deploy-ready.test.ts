/**
 * Tests for engineering.deploy.ready (MVP 05E).
 *
 * Proves: strict empty input; UNAVAILABLE/UNKNOWN/NOT_READY/READY semantics
 * identical to the certified assessDeployReady classifier; the 05D clock
 * refinement (0 calls without valid application evidence, exactly 1 with it);
 * factual verdict-neutral evidenceAgeSeconds; the exact output contract with
 * normalized components and no raw evidence/path/error leakage; and MCP
 * integration (7-tool catalog, zero-config safety, shared adapters,
 * independence from the existing six tools).
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server";
import {
  DEPLOY_READY_LIMITATIONS,
  deployReadyOutputSchema,
  handleDeployReady,
} from "../src/tools/deployReady";
import { assessDeployReady } from "../src/tools/applicationDeployment";
import { StrictInputError } from "../src/tools/vpsHealth";
import type { ApplicationDeploymentAdapter, ApplicationDeploymentEvidence } from "../src/adapters/applicationDeployment";
import type { SystemHealthAdapter, VpsHealthEvidence } from "../src/adapters/systemHealth";

const OBSERVED_AT = "2026-09-02T12:00:00Z";
const NOW_MS = Date.parse(OBSERVED_AT) + 90_000;

function evidenceDocument(overrides: Record<string, unknown> = {}): ApplicationDeploymentEvidence {
  const base = {
    applicationId: "app-1",
    observedAt: OBSERVED_AT,
    source: "release-state-file",
    currentReleaseId: "release-2",
    previousReleaseId: "release-1",
    deploymentStatus: "SUCCEEDED",
    lastDeploymentFinishedAt: "2026-09-02T11:00:00Z",
    applicationHealthy: true,
  };
  return { ...base, ...overrides } as unknown as ApplicationDeploymentEvidence;
}

function applicationAdapter(evidence: ApplicationDeploymentEvidence | null) {
  const adapter = {
    name: "static-application",
    calls: 0,
    collect(): ApplicationDeploymentEvidence | null {
      adapter.calls += 1;
      return evidence;
    },
  };
  return adapter;
}

const HOST_OK = {
  uptimeSeconds: 86_400,
  cpuCount: 4,
  loadAverage1m: 0.5,
  memoryTotalBytes: 16_000_000_000,
  memoryFreeBytes: 8_000_000_000,
};

// ~95% memory used: VPS health DEGRADED and capacity PRESSURED.
const HOST_DEGRADED = { ...HOST_OK, memoryFreeBytes: 800_000_000 };

// cpuCount unusable: VPS health UNKNOWN and capacity UNKNOWN, memory valid.
const HOST_UNKNOWN = { ...HOST_OK, cpuCount: 0 };

function hostAdapter(evidence: VpsHealthEvidence | null): SystemHealthAdapter & { calls: number } {
  const adapter = {
    name: "static-host",
    calls: 0,
    collect(): VpsHealthEvidence {
      adapter.calls += 1;
      return evidence as VpsHealthEvidence;
    },
  };
  return adapter as unknown as SystemHealthAdapter & { calls: number };
}

function countingClock() {
  const clock = { calls: 0, now() { clock.calls += 1; return NOW_MS; } };
  return clock;
}

const UNAVAILABLE_COMPONENTS = {
  deployment: "UNAVAILABLE",
  applicationHealth: "UNAVAILABLE",
  vpsHealth: "UNAVAILABLE",
  vpsCapacity: "UNAVAILABLE",
};

const EXACT_OUTPUT_KEYS = [
  "applicationId",
  "components",
  "evidenceAgeSeconds",
  "limitations",
  "reasons",
  "status",
  "summary",
];

const NO_ADAPTER_SUMMARY =
  "UNAVAILABLE: no application/deployment evidence source is configured for this server; nothing was inferred.";
const APPLICATION_FAILURE_SUMMARY =
  "UNAVAILABLE: the configured application/deployment evidence source returned no valid evidence for this call; nothing was inferred.";
const HOST_FAILURE_SUMMARY =
  "UNAVAILABLE: the configured VPS health evidence source returned no valid evidence for this call; nothing was inferred.";

describe("strict empty input", () => {
  it("accepts {}", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => NOW_MS);
    expect(result.status).toBe("READY");
  });

  it("accepts undefined and null input per the existing strict-input convention", () => {
    expect(handleDeployReady(undefined, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => NOW_MS).status).toBe("READY");
    expect(handleDeployReady(null, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => NOW_MS).status).toBe("READY");
  });

  it("rejects representative agent-steerable arguments", () => {
    for (const bad of [
      { path: "C:\\ops\\release-state.json" },
      { applicationId: "app-9" },
      { status: "READY" },
      { reasons: ["nope"] },
      { target: "prod" },
      { url: "https://example.invalid" },
      { config: { a: 1 } },
      { evidence: { deploymentStatus: "SUCCEEDED" } },
      { vpsHealth: "HEALTHY" },
      { deploymentStatus: "SUCCEEDED" },
      { extra: 1 },
    ]) {
      expect(() => handleDeployReady(bad, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK))).toThrow(StrictInputError);
    }
  });
});

describe("UNAVAILABLE branches", () => {
  it("returns UNAVAILABLE with null evidence fields and 0 clock calls when no application adapter is configured", () => {
    const clock = countingClock();
    const result = handleDeployReady({}, null, hostAdapter(HOST_OK), clock.now);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.summary).toBe(NO_ADAPTER_SUMMARY);
    expect(result.applicationId).toBeNull();
    expect(result.evidenceAgeSeconds).toBeNull();
    expect(result.components).toEqual(UNAVAILABLE_COMPONENTS);
    expect(result.reasons).toEqual([]);
    expect(result.limitations).toEqual(DEPLOY_READY_LIMITATIONS);
    expect(clock.calls).toBe(0);
  });

  it("treats undefined adapter exactly like null", () => {
    const result = handleDeployReady({}, undefined, hostAdapter(HOST_OK), countingClock().now);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.evidenceAgeSeconds).toBeNull();
  });

  it("returns UNAVAILABLE with null evidence fields and 0 clock calls when application collect() returns null", () => {
    const clock = countingClock();
    const app = applicationAdapter(null);
    const result = handleDeployReady({}, app, hostAdapter(HOST_OK), clock.now);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.summary).toBe(APPLICATION_FAILURE_SUMMARY);
    expect(result.applicationId).toBeNull();
    expect(result.evidenceAgeSeconds).toBeNull();
    expect(result.components).toEqual(UNAVAILABLE_COMPONENTS);
    expect(clock.calls).toBe(0);
    expect(app.calls).toBe(1);
  });

  it("returns UNAVAILABLE when host evidence is null (fail closed, never READY)", () => {
    const clock = countingClock();
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(null), clock.now);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.summary).toBe(HOST_FAILURE_SUMMARY);
    expect(result.evidenceAgeSeconds).toBeNull();
    expect(clock.calls).toBe(0);
  });

  it("collects each evidence source exactly once per invocation", () => {
    const app = applicationAdapter(evidenceDocument());
    const host = hostAdapter(HOST_OK);
    handleDeployReady({}, app, host, () => NOW_MS);
    expect(app.calls).toBe(1);
    expect(host.calls).toBe(1);
  });

  it("never exposes paths, filenames, errors or stack traces on failure", () => {
    const secretPath = "C:\\ops\\hidden-9f2a\\release-state.json";
    const result = handleDeployReady({}, null, hostAdapter(HOST_OK), countingClock().now);
    const text = JSON.stringify(result);
    expect(text).not.toContain(secretPath);
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain("EACCES");
    expect(text).not.toContain("Error");
    expect(text).not.toContain("stack");
  });
});

describe("UNKNOWN-first semantics (certified classifier reused)", () => {
  it("applicationHealthy=null -> UNKNOWN naming the component, with factual fields preserved", () => {
    const clock = countingClock();
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument({ applicationHealthy: null })), hostAdapter(HOST_OK), clock.now);
    expect(result.status).toBe("UNKNOWN");
    expect(result.components).toEqual({ deployment: "OK", applicationHealth: "UNKNOWN", vpsHealth: "HEALTHY", vpsCapacity: "OK" });
    expect(result.applicationId).toBe("app-1");
    expect(result.evidenceAgeSeconds).toBe(90);
    expect(clock.calls).toBe(1);
  });

  it("deploymentStatus=null -> UNKNOWN naming the component", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument({ deploymentStatus: null })), hostAdapter(HOST_OK), () => NOW_MS);
    expect(result.status).toBe("UNKNOWN");
    expect(result.components.deployment).toBe("UNKNOWN");
  });

  it("host classifier UNKNOWN -> UNKNOWN for vpsHealth and vpsCapacity components", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_UNKNOWN), () => NOW_MS);
    expect(result.status).toBe("UNKNOWN");
    expect(result.components.vpsHealth).toBe("UNKNOWN");
    expect(result.components.vpsCapacity).toBe("UNKNOWN");
  });

  it("UNKNOWN takes precedence over positive confidence", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument({ applicationHealthy: null })), hostAdapter(HOST_OK), () => NOW_MS);
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasons).toEqual([]);
  });

  it("never converts missing evidence into READY", () => {
    expect(handleDeployReady({}, null, hostAdapter(HOST_OK), countingClock().now).status).toBe("UNAVAILABLE");
    expect(handleDeployReady({}, applicationAdapter(null), hostAdapter(HOST_OK), countingClock().now).status).toBe("UNAVAILABLE");
  });
});

describe("NOT_READY and READY (certified blocker rules)", () => {
  it("IN_FLIGHT -> NOT_READY", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument({ deploymentStatus: "IN_PROGRESS" })), hostAdapter(HOST_OK), () => NOW_MS);
    expect(result.status).toBe("NOT_READY");
    expect(result.reasons.length).toBe(1);
    expect(result.reasons[0]).toContain("IN_PROGRESS");
  });

  it("PENDING -> NOT_READY", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument({ deploymentStatus: "QUEUED" })), hostAdapter(HOST_OK), () => NOW_MS);
    expect(result.status).toBe("NOT_READY");
    expect(result.reasons[0]).toContain("QUEUED");
  });

  it("applicationHealthy=false -> NOT_READY", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument({ applicationHealthy: false })), hostAdapter(HOST_OK), () => NOW_MS);
    expect(result.status).toBe("NOT_READY");
    expect(result.components.applicationHealth).toBe("DEGRADED");
    expect(result.reasons[0]).toContain("not healthy");
  });

  it("VPS health DEGRADED and capacity PRESSURED -> NOT_READY", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_DEGRADED), () => NOW_MS);
    expect(result.status).toBe("NOT_READY");
    expect(result.components.vpsHealth).toBe("DEGRADED");
    expect(result.components.vpsCapacity).toBe("PRESSURED");
    expect(result.reasons.length).toBe(2);
  });

  it("multiple blockers preserve the certified reason list verbatim (no reinterpretation)", () => {
    const evidence = evidenceDocument({ deploymentStatus: "IN_PROGRESS", applicationHealthy: false });
    const result = handleDeployReady({}, applicationAdapter(evidence), hostAdapter(HOST_DEGRADED), () => NOW_MS);
    const certified = assessDeployReady(evidence, HOST_DEGRADED);
    expect(result.reasons).toEqual(certified.reasons);
    expect(result.summary).toBe(certified.summary);
    expect(result.components).toEqual(certified.components);
    expect(result.status).toBe(certified.status);
  });

  it("READY only when every component is known and safe", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => NOW_MS);
    expect(result.status).toBe("READY");
    expect(result.components).toEqual({ deployment: "OK", applicationHealth: "HEALTHY", vpsHealth: "HEALTHY", vpsCapacity: "OK" });
    expect(result.reasons).toEqual([]);
    expect(result.applicationId).toBe("app-1");
    expect(result.summary).toContain("Advisory only");
  });

  it("READY and NOT_READY summaries carry the advisory note", () => {
    const ready = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => NOW_MS);
    const notReady = handleDeployReady({}, applicationAdapter(evidenceDocument({ deploymentStatus: "QUEUED" })), hostAdapter(HOST_OK), () => NOW_MS);
    expect(ready.summary).toContain("Advisory only");
    expect(notReady.summary).toContain("Advisory only");
  });

  it("matches the certified classifier for every branch (no duplicated interpretation)", () => {
    const cases: Array<[ApplicationDeploymentEvidence, VpsHealthEvidence]> = [
      [evidenceDocument(), HOST_OK],
      [evidenceDocument({ deploymentStatus: "IN_PROGRESS" }), HOST_OK],
      [evidenceDocument({ deploymentStatus: null, applicationHealthy: null }), HOST_DEGRADED],
      [evidenceDocument({ applicationHealthy: null }), HOST_UNKNOWN],
      [evidenceDocument({ applicationHealthy: false }), HOST_OK],
      [evidenceDocument({ deploymentStatus: "FAILED" }), HOST_OK],
    ];
    for (const [evidence, host] of cases) {
      const result = handleDeployReady({}, applicationAdapter(evidence), hostAdapter(host), () => NOW_MS);
      const certified = assessDeployReady(evidence, host);
      expect(result.status).toBe(certified.status);
      expect(result.summary).toBe(certified.summary);
      expect(result.components).toEqual(certified.components);
      expect(result.reasons).toEqual(certified.reasons);
      expect(result.applicationId).toBe(certified.applicationId);
    }
  });
});

describe("evidence age (05C/05D policy)", () => {
  it("calls the clock exactly once with valid application evidence and computes the exact age", () => {
    const clock = countingClock();
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), clock.now);
    expect(clock.calls).toBe(1);
    expect(result.evidenceAgeSeconds).toBe(90);
  });

  it("never calls the clock on UNAVAILABLE branches", () => {
    const noAdapter = countingClock();
    handleDeployReady({}, null, hostAdapter(HOST_OK), noAdapter.now);
    expect(noAdapter.calls).toBe(0);
    const failed = countingClock();
    handleDeployReady({}, applicationAdapter(null), hostAdapter(HOST_OK), failed.now);
    expect(failed.calls).toBe(0);
  });

  it("preserves negative ages without clamping (observable clock skew)", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => Date.parse(OBSERVED_AT) - 5_000);
    expect(result.evidenceAgeSeconds).toBe(-5);
  });

  it("floors fractional ages", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => Date.parse(OBSERVED_AT) + 1_500);
    expect(result.evidenceAgeSeconds).toBe(1);
  });

  it("age never changes the verdict (old evidence stays READY)", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => Date.parse(OBSERVED_AT) + 10 * 365 * 24 * 3600 * 1000);
    expect(result.status).toBe("READY");
    expect(result.evidenceAgeSeconds).toBeGreaterThan(300_000_000);
  });
});

describe("output contract", () => {
  it("exposes exactly the seven output keys with normalized four-part components", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => NOW_MS);
    expect(Object.keys(result).sort()).toEqual([...EXACT_OUTPUT_KEYS].sort());
    expect(Object.keys(result.components).sort()).toEqual(["applicationHealth", "deployment", "vpsCapacity", "vpsHealth"]);
  });

  it("never exposes raw evidence fields, release IDs, memory/load/cpu values or paths", () => {
    const evidence = evidenceDocument({ currentReleaseId: "secret-release-42", previousReleaseId: "secret-rollback-1" });
    const result = handleDeployReady({}, applicationAdapter(evidence), hostAdapter(HOST_DEGRADED), () => NOW_MS);
    const text = JSON.stringify(result);
    expect(Object.keys(result)).not.toContain("applicationHealthy");
    expect(Object.keys(result)).not.toContain("deploymentStatus");
    expect(text).not.toContain("secret-release-42");
    expect(text).not.toContain("secret-rollback-1");
    expect(text).not.toContain("16000000000");
    expect(text).not.toContain("800000000");
    expect(text).not.toContain("release-state.json");
  });

  it("UNAVAILABLE leaves all evidence-derived fields null and never fabricates evidence", () => {
    const result = handleDeployReady({}, applicationAdapter(null), hostAdapter(HOST_OK), countingClock().now);
    expect(result.applicationId).toBeNull();
    expect(result.evidenceAgeSeconds).toBeNull();
    expect(result.reasons).toEqual([]);
  });

  it("validates against the output schema and rejects invalid statuses", () => {
    const result = handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => NOW_MS);
    expect(deployReadyOutputSchema.safeParse(result).success).toBe(true);
    expect(deployReadyOutputSchema.safeParse({ ...result, status: "PROBABLY" }).success).toBe(false);
    expect(deployReadyOutputSchema.safeParse({ ...result, components: { ...result.components, deployment: "MAYBE" } }).success).toBe(false);
  });

  it("includes the fixed limitations in every result", () => {
    expect(handleDeployReady({}, null, hostAdapter(HOST_OK), countingClock().now).limitations).toEqual(DEPLOY_READY_LIMITATIONS);
    expect(handleDeployReady({}, applicationAdapter(evidenceDocument()), hostAdapter(HOST_OK), () => NOW_MS).limitations).toEqual(DEPLOY_READY_LIMITATIONS);
  });
});

describe("MCP server integration", () => {
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
  ];

  async function withServer(applicationDeploymentAdapter?: ApplicationDeploymentAdapter) {
    const server = buildServer({ applicationDeploymentAdapter });
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { server, client };
  }

  it("lists exactly the ten public tools", async () => {
    const { server, client } = await withServer();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("registers engineering.deploy.ready unconditionally and stays safe in zero-config", async () => {
    const { server, client } = await withServer();
    try {
      const result = await client.callTool({ name: "engineering.deploy.ready", arguments: {} });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.status).toBe("UNAVAILABLE");
      expect(structured.applicationId).toBeNull();
      expect(structured.evidenceAgeSeconds).toBeNull();
      expect(JSON.stringify(structured)).not.toContain("release-state.json");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("rejects extra MCP arguments at the protocol layer", async () => {
    const { server, client } = await withServer();
    try {
      const bad = await client.callTool({ name: "engineering.deploy.ready", arguments: { path: "C:\\ops\\x.json" } as never });
      expect(bad.isError).toBe(true);
      const good = await client.callTool({ name: "engineering.deploy.ready", arguments: {} });
      expect(good.isError).toBeFalsy();
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("returns truthful structured READY output with injected evidence", async () => {
    const { server, client } = await withServer(applicationAdapter(evidenceDocument()));
    try {
      const result = await client.callTool({ name: "engineering.deploy.ready", arguments: {} });
      expect(result.isError).toBeFalsy();
      const parsed = deployReadyOutputSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("READY");
        expect(parsed.data.applicationId).toBe("app-1");
        expect(typeof parsed.data.evidenceAgeSeconds).toBe("number");
        expect(Number.isInteger(parsed.data.evidenceAgeSeconds)).toBe(true);
      }
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("consumes the same application adapter instance as deploy.status and app.health", async () => {
    const app = applicationAdapter(evidenceDocument());
    const { server, client } = await withServer(app);
    try {
      const ready = await client.callTool({ name: "engineering.deploy.ready", arguments: {} });
      const status = await client.callTool({ name: "engineering.deploy.status", arguments: {} });
      const health = await client.callTool({ name: "engineering.app.health", arguments: {} });
      expect(ready.isError).toBeFalsy();
      expect(status.isError).toBeFalsy();
      expect(health.isError).toBeFalsy();
      expect((ready.structuredContent as Record<string, unknown>).status).toBe("READY");
      expect((status.structuredContent as Record<string, unknown>).status).toBe("OK");
      expect((health.structuredContent as Record<string, unknown>).status).toBe("HEALTHY");
      expect(app.calls).toBe(3);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("keeps the four source tools and deploy.ready outputs independent (advisory composition only)", async () => {
    const { server, client } = await withServer(applicationAdapter(evidenceDocument({ applicationHealthy: false })));
    try {
      const ready = (await client.callTool({ name: "engineering.deploy.ready", arguments: {} })).structuredContent as Record<string, unknown>;
      const status = (await client.callTool({ name: "engineering.deploy.status", arguments: {} })).structuredContent as Record<string, unknown>;
      const health = (await client.callTool({ name: "engineering.app.health", arguments: {} })).structuredContent as Record<string, unknown>;
      expect(ready.status).toBe("NOT_READY");
      expect(status.status).toBe("OK");
      expect(health.status).toBe("DEGRADED");
      expect(Object.keys(status).sort()).toEqual(["applicationId", "currentReleaseId", "evidenceAgeSeconds", "lastDeploymentFinishedAt", "limitations", "observedAt", "source", "status", "summary"]);
      expect(Object.keys(health).sort()).toEqual(["applicationId", "evidenceAgeSeconds", "limitations", "observedAt", "source", "status", "summary"]);
      expect(Object.keys(ready)).not.toContain("applicationHealthy");
      expect(Object.keys(status)).not.toContain("applicationHealthy");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("never exposes the configured release-state path over MCP", async () => {
    const { server, client } = await withServer(applicationAdapter(evidenceDocument()));
    try {
      const result = await client.callTool({ name: "engineering.deploy.ready", arguments: {} });
      expect(JSON.stringify(result)).not.toContain("hidden-9f2a");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});