import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server";
import {
  APP_HEALTH_LIMITATIONS,
  appHealthOutputSchema,
  handleAppHealth,
} from "../src/tools/appHealth";
import { deployStatusOutputSchema, handleDeployStatus } from "../src/tools/deployStatus";
import { StrictInputError } from "../src/tools/vpsHealth";
import { createReleaseStateFileAdapter } from "../src/adapters/releaseStateFile";
import type {
  ApplicationDeploymentAdapter,
  ApplicationDeploymentEvidence,
} from "../src/adapters/applicationDeployment";

const OBSERVED_AT = "2026-09-02T12:00:00Z";
const NOW_MS = Date.parse("2026-09-02T12:01:30Z"); // 90s after OBSERVED_AT

function evidenceDocument(overrides: Record<string, unknown> = {}): ApplicationDeploymentEvidence {
  const base: ApplicationDeploymentEvidence = {
    applicationId: "app-1",
    observedAt: OBSERVED_AT,
    source: "release-state-file-test",
    currentReleaseId: "release-2",
    previousReleaseId: "release-1",
    deploymentStatus: "SUCCEEDED",
    lastDeploymentFinishedAt: "2026-09-02T11:30:00Z",
    applicationHealthy: true,
  };
  return { ...base, ...overrides } as ApplicationDeploymentEvidence;
}

function staticAdapter(
  evidence: ApplicationDeploymentEvidence | null,
): ApplicationDeploymentAdapter & { calls: number } {
  const adapter = {
    name: "static-test",
    calls: 0,
    collect(): ApplicationDeploymentEvidence | null {
      adapter.calls += 1;
      return evidence;
    },
  };
  return adapter;
}

function countingClock(returnValue: number): { now: () => number; calls: () => number } {
  let calls = 0;
  return {
    now: () => {
      calls += 1;
      return returnValue;
    },
    calls: () => calls,
  };
}

function allEvidenceFieldsNull(result: {
  applicationId: unknown;
  source: unknown;
  observedAt: unknown;
  evidenceAgeSeconds: unknown;
}): void {
  expect(result.applicationId).toBeNull();
  expect(result.source).toBeNull();
  expect(result.observedAt).toBeNull();
  expect(result.evidenceAgeSeconds).toBeNull();
}

const EXACT_OUTPUT_KEYS = [
  "status",
  "summary",
  "applicationId",
  "source",
  "observedAt",
  "evidenceAgeSeconds",
  "limitations",
];

describe("strict empty input", () => {
  it("accepts exactly {} and undefined, rejects extra keys and non-objects", () => {
    const adapter = staticAdapter(evidenceDocument());
    expect(handleAppHealth({}, adapter, () => NOW_MS).status).toBe("HEALTHY");
    expect(handleAppHealth(undefined, adapter, () => NOW_MS).status).toBe("HEALTHY");
    expect(() => handleAppHealth({ path: "x" }, adapter, () => NOW_MS)).toThrow(StrictInputError);
    expect(() => handleAppHealth({ applicationId: "x" }, adapter, () => NOW_MS)).toThrow(
      StrictInputError,
    );
    expect(() => handleAppHealth({ health: true }, adapter, () => NOW_MS)).toThrow(StrictInputError);
    expect(() => handleAppHealth("x" as unknown, adapter, () => NOW_MS)).toThrow(StrictInputError);
    expect(() => handleAppHealth([], adapter, () => NOW_MS)).toThrow(StrictInputError);
  });

  it("accepts null exactly like the existing strict-input convention", () => {
    expect(handleAppHealth(null, staticAdapter(evidenceDocument()), () => NOW_MS).status).toBe(
      "HEALTHY",
    );
  });

  it("rejects every parameter the agent must never control", () => {
    const adapter = staticAdapter(evidenceDocument());
    for (const bad of [
      { evidence: {} },
      { source: "x" },
      { releaseId: "r" },
      { url: "https://example.invalid" },
      { credentials: "c" },
      { target: "t" },
      { config: {} },
      { observedAt: OBSERVED_AT },
      { status: "HEALTHY" },
    ]) {
      expect(() => handleAppHealth(bad, adapter, () => NOW_MS)).toThrow(StrictInputError);
    }
  });
});

describe("no adapter configured", () => {
  it("returns UNAVAILABLE with all evidence-derived fields null", () => {
    const clock = countingClock(NOW_MS);
    const result = handleAppHealth({}, null, clock.now);
    expect(result.status).toBe("UNAVAILABLE");
    allEvidenceFieldsNull(result);
    expect(result.limitations).toEqual(APP_HEALTH_LIMITATIONS);
  });

  it("uses the fixed no-adapter summary without interpolation", () => {
    const result = handleAppHealth({}, null, () => NOW_MS);
    expect(result.summary).toBe(
      "UNAVAILABLE: no application/deployment evidence source is configured for this server; nothing was inferred.",
    );
  });

  it("never calls the clock when no adapter exists (0 calls)", () => {
    const clock = countingClock(NOW_MS);
    handleAppHealth({}, null, clock.now);
    expect(clock.calls()).toBe(0);
  });

  it("treats undefined exactly like null", () => {
    const clock = countingClock(NOW_MS);
    expect(handleAppHealth({}, undefined, clock.now).status).toBe("UNAVAILABLE");
    expect(clock.calls()).toBe(0);
  });

  it("never throws and exposes no path or error text", () => {
    const result = handleAppHealth({}, null, () => NOW_MS);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/path|Error|stack/i);
  });
});

describe("adapter exists but collect() returns null", () => {
  it("returns UNAVAILABLE with all evidence-derived fields null", () => {
    const clock = countingClock(NOW_MS);
    const adapter = staticAdapter(null);
    const result = handleAppHealth({}, adapter, clock.now);
    expect(adapter.calls).toBe(1);
    expect(result.status).toBe("UNAVAILABLE");
    allEvidenceFieldsNull(result);
    expect(result.limitations).toEqual(APP_HEALTH_LIMITATIONS);
  });

  it("uses the fixed failed-evidence summary without interpolation", () => {
    const result = handleAppHealth({}, staticAdapter(null), () => NOW_MS);
    expect(result.summary).toBe(
      "UNAVAILABLE: the configured application/deployment evidence source returned no valid evidence for this call; nothing was inferred.",
    );
  });

  it("never calls the clock when the source returned nothing (0 calls)", () => {
    const clock = countingClock(NOW_MS);
    handleAppHealth({}, staticAdapter(null), clock.now);
    expect(clock.calls()).toBe(0);
  });

  it("collects evidence exactly once per invocation (no cache, no retry)", () => {
    const adapter = staticAdapter(null);
    handleAppHealth({}, adapter, () => NOW_MS);
    handleAppHealth({}, adapter, () => NOW_MS);
    expect(adapter.calls).toBe(2);
  });

  it("leaks no configured path, filesystem error or stack trace", () => {
    const secretPath = "C:\\ops\\hidden-9f2a\\release-state.json";
    const adapter = createReleaseStateFileAdapter({ path: secretPath });
    const result = handleAppHealth({}, adapter, () => NOW_MS);
    const text = JSON.stringify(result);
    expect(result.status).toBe("UNAVAILABLE");
    expect(text).not.toContain("hidden-9f2a");
    expect(text).not.toContain("release-state.json");
    expect(text).not.toMatch(/ENOENT|EACCES|stack|Error/i);
  });
});

describe("application health mapping (certified classifier reused)", () => {
  for (const [applicationHealthy, expected] of [
    [true, "HEALTHY"],
    [false, "DEGRADED"],
  ] as const) {
    it(`maps applicationHealthy=${applicationHealthy} -> ${expected}`, () => {
      const result = handleAppHealth(
        {},
        staticAdapter(evidenceDocument({ applicationHealthy })),
        () => NOW_MS,
      );
      expect(result.status).toBe(expected);
      expect(appHealthOutputSchema.safeParse(result).success).toBe(true);
    });
  }

  it("returns UNKNOWN when valid evidence explicitly lacks applicationHealthy", () => {
    const result = handleAppHealth(
      {},
      staticAdapter(evidenceDocument({ applicationHealthy: null })),
      () => NOW_MS,
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.summary).toBe(
      "UNKNOWN: applicationHealthy was not reported by the evidence source; no application health is inferred.",
    );
  });

  it("UNKNOWN preserves applicationId, source and observedAt with a normal factual age", () => {
    const result = handleAppHealth(
      {},
      staticAdapter(evidenceDocument({ applicationHealthy: null })),
      () => NOW_MS,
    );
    expect(result.applicationId).toBe("app-1");
    expect(result.source).toBe("release-state-file-test");
    expect(result.observedAt).toBe(OBSERVED_AT);
    expect(result.evidenceAgeSeconds).toBe(90);
  });

  it("reuses the certified classifier summaries verbatim (no rewording)", () => {
    expect(handleAppHealth({}, staticAdapter(evidenceDocument({ applicationHealthy: true })), () => NOW_MS).summary).toBe(
      "HEALTHY: the evidence source reports the application as healthy.",
    );
    expect(handleAppHealth({}, staticAdapter(evidenceDocument({ applicationHealthy: false })), () => NOW_MS).summary).toBe(
      "DEGRADED: the evidence source reports the application as not healthy.",
    );
  });
});

describe("factual passthrough and provenance", () => {
  it("passes applicationId, source and observedAt through exactly", () => {
    const result = handleAppHealth({}, staticAdapter(evidenceDocument()), () => NOW_MS);
    expect(result.applicationId).toBe("app-1");
    expect(result.source).toBe("release-state-file-test");
    expect(result.observedAt).toBe(OBSERVED_AT);
  });

  it("keeps provenance truthful for DEGRADED evidence as well", () => {
    const result = handleAppHealth(
      {},
      staticAdapter(evidenceDocument({ applicationHealthy: false })),
      () => NOW_MS,
    );
    expect(result.status).toBe("DEGRADED");
    expect(result.applicationId).toBe("app-1");
    expect(result.observedAt).toBe(OBSERVED_AT);
  });
});

describe("staleness / age (05C factual policy with 05D clock refinement)", () => {
  it("computes evidenceAgeSeconds exactly with the injected clock", () => {
    const result = handleAppHealth({}, staticAdapter(evidenceDocument()), () => NOW_MS);
    expect(result.evidenceAgeSeconds).toBe(90);
  });

  it("preserves negative age (observable clock skew) without clamping", () => {
    const before = Date.parse(OBSERVED_AT) - 5000;
    const result = handleAppHealth({}, staticAdapter(evidenceDocument()), () => before);
    expect(result.evidenceAgeSeconds).toBe(-5);
  });

  it("uses a float-safe floor (not rounding)", () => {
    const midSecond = Date.parse(OBSERVED_AT) + 1500;
    const result = handleAppHealth({}, staticAdapter(evidenceDocument()), () => midSecond);
    expect(result.evidenceAgeSeconds).toBe(1);
  });

  it("calls the clock exactly once when valid evidence exists", () => {
    const clock = countingClock(NOW_MS);
    handleAppHealth({}, staticAdapter(evidenceDocument()), clock.now);
    expect(clock.calls()).toBe(1);
  });

  it("never lets age change the status (ancient evidence stays HEALTHY)", () => {
    const ancientNow = Date.parse("2027-01-01T00:00:00Z");
    const result = handleAppHealth({}, staticAdapter(evidenceDocument()), () => ancientNow);
    expect(result.status).toBe("HEALTHY");
    expect(result.evidenceAgeSeconds).toBeGreaterThan(1000000);
  });

  it("does not fabricate an age when no valid evidence exists", () => {
    expect(handleAppHealth({}, null, () => NOW_MS).evidenceAgeSeconds).toBeNull();
    expect(handleAppHealth({}, staticAdapter(null), () => NOW_MS).evidenceAgeSeconds).toBeNull();
  });
});

describe("exact output contract", () => {
  it("emits exactly the documented keys for every branch", () => {
    const branches = [
      handleAppHealth({}, null, () => NOW_MS),
      handleAppHealth({}, staticAdapter(null), () => NOW_MS),
      handleAppHealth({}, staticAdapter(evidenceDocument()), () => NOW_MS),
      handleAppHealth({}, staticAdapter(evidenceDocument({ applicationHealthy: null })), () => NOW_MS),
    ];
    for (const result of branches) {
      expect(Object.keys(result).sort()).toEqual([...EXACT_OUTPUT_KEYS].sort());
    }
  });

  it("never exposes applicationHealthy, deploymentStatus or release fields", () => {
    const result = handleAppHealth({}, staticAdapter(evidenceDocument()), () => NOW_MS);
    for (const forbidden of [
      "applicationHealthy",
      "deploymentStatus",
      "currentReleaseId",
      "previousReleaseId",
      "lastDeploymentFinishedAt",
    ]) {
      expect(Object.keys(result)).not.toContain(forbidden);
    }
    const text = JSON.stringify(result);
    expect(text).not.toContain("release-1");
    expect(text).not.toContain("release-2");
    expect(text).not.toContain("2026-09-02T11:30:00Z");
    expect(text).not.toContain("SUCCEEDED");
  });

  it("validates against the output schema and rejects invalid verdicts", () => {
    const result = handleAppHealth({}, staticAdapter(evidenceDocument()), () => NOW_MS);
    expect(appHealthOutputSchema.safeParse(result).success).toBe(true);
    expect(appHealthOutputSchema.safeParse({ ...result, status: "ROLLED_BACK" }).success).toBe(false);
  });

  it("includes the fixed limitations in every output", () => {
    for (const result of [
      handleAppHealth({}, null, () => NOW_MS),
      handleAppHealth({}, staticAdapter(null), () => NOW_MS),
      handleAppHealth({}, staticAdapter(evidenceDocument()), () => NOW_MS),
      handleAppHealth({}, staticAdapter(evidenceDocument({ applicationHealthy: null })), () => NOW_MS),
    ]) {
      expect(result.limitations).toEqual(APP_HEALTH_LIMITATIONS);
    }
  });
});

describe("MCP server integration", () => {
  it("lists exactly the ten public tools", async () => {
    const server = buildServer();
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect([...listed.tools].map((t) => t.name).sort()).toEqual(
        [
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
        ].sort(),
      );
      const tool = listed.tools.find((t) => t.name === "engineering.app.health");
      expect(tool).toBeDefined();
      expect((tool!.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("registers engineering.app.health unconditionally (present in zero-config build)", async () => {
    const server = buildServer();
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.some((t) => t.name === "engineering.app.health")).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports UNAVAILABLE over MCP in the zero-config build with all fields null", async () => {
    const server = buildServer();
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "engineering.app.health", arguments: {} });
      expect(result.isError).toBeFalsy();
      const parsed = appHealthOutputSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("UNAVAILABLE");
        allEvidenceFieldsNull(parsed.data);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns truthful structured output with an injected adapter", async () => {
    const server = buildServer({ applicationDeploymentAdapter: staticAdapter(evidenceDocument()) });
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "engineering.app.health", arguments: {} });
      expect(result.isError).toBeFalsy();
      const parsed = appHealthOutputSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("HEALTHY");
        expect(parsed.data.applicationId).toBe("app-1");
        // Over MCP the default invocation-time clock runs; exact-age
        // determinism is proven by the unit tests with an injected clock.
        expect(typeof parsed.data.evidenceAgeSeconds).toBe("number");
        expect(Number.isInteger(parsed.data.evidenceAgeSeconds)).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects extra MCP arguments at the protocol layer", async () => {
    const server = buildServer({ applicationDeploymentAdapter: staticAdapter(evidenceDocument()) });
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const bad = await client.callTool({
        name: "engineering.app.health",
        arguments: { applicationId: "x" },
      });
      expect(bad.isError).toBe(true);
      const text = JSON.stringify(bad.content);
      expect(text).not.toContain("hidden-9f2a");
      const good = await client.callTool({ name: "engineering.app.health", arguments: {} });
      expect(good.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves engineering.deploy.status and engineering.app.health from the same adapter instance", async () => {
    const adapter = staticAdapter(evidenceDocument());
    const server = buildServer({ applicationDeploymentAdapter: adapter });
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const deployResult = await client.callTool({ name: "engineering.deploy.status", arguments: {} });
      const appResult = await client.callTool({ name: "engineering.app.health", arguments: {} });
      expect(deployResult.isError).toBeFalsy();
      expect(appResult.isError).toBeFalsy();
      expect(adapter.calls).toBe(2);
      const deployParsed = deployStatusOutputSchema.safeParse(deployResult.structuredContent);
      const appParsed = appHealthOutputSchema.safeParse(appResult.structuredContent);
      expect(deployParsed.success).toBe(true);
      expect(appParsed.success).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps contradictory deployment/health combinations independent (no reconciliation)", async () => {
    for (const [deploymentStatus, applicationHealthy, deployStatus, appStatus] of [
      ["SUCCEEDED", false, "OK", "DEGRADED"],
      ["FAILED", true, "FAILED", "HEALTHY"],
    ] as const) {
      const server = buildServer({
        applicationDeploymentAdapter: staticAdapter(
          evidenceDocument({ deploymentStatus, applicationHealthy }),
        ),
      });
      const client = new Client({ name: "smoke-client", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const deployResult = await client.callTool({ name: "engineering.deploy.status", arguments: {} });
        const appResult = await client.callTool({ name: "engineering.app.health", arguments: {} });
        const deployParsed = deployStatusOutputSchema.safeParse(deployResult.structuredContent);
        const appParsed = appHealthOutputSchema.safeParse(appResult.structuredContent);
        expect(deployParsed.success).toBe(true);
        expect(appParsed.success).toBe(true);
        if (deployParsed.success && appParsed.success) {
          expect(deployParsed.data.status).toBe(deployStatus);
          expect(appParsed.data.status).toBe(appStatus);
        }
        // Each tool exposes only its own question's fields.
        const appKeys = Object.keys(appResult.structuredContent as Record<string, unknown>);
        expect(appKeys).not.toContain("deploymentStatus");
        expect(appKeys).not.toContain("currentReleaseId");
        expect(appKeys).not.toContain("lastDeploymentFinishedAt");
        const deployKeys = Object.keys(deployResult.structuredContent as Record<string, unknown>);
        expect(deployKeys).not.toContain("applicationHealthy");
      } finally {
        await client.close();
        await server.close();
      }
    }
  });

  it("leaves the deploy.status output contract unchanged", async () => {
    const server = buildServer({ applicationDeploymentAdapter: staticAdapter(evidenceDocument()) });
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "engineering.deploy.status", arguments: {} });
      expect(result.isError).toBeFalsy();
      const keys = Object.keys(result.structuredContent as Record<string, unknown>).sort();
      expect(keys).toEqual(
        [
          "applicationId",
          "currentReleaseId",
          "evidenceAgeSeconds",
          "lastDeploymentFinishedAt",
          "limitations",
          "observedAt",
          "source",
          "status",
          "summary",
        ].sort(),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps the existing five tools callable", async () => {
    const server = buildServer();
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      for (const name of [
        "engineering.vps.health",
        "engineering.vps.capacity",
        "engineering.vps.what_changed",
        "engineering.vps.incident.summary",
        "engineering.deploy.status",
        "engineering.docker.health",
        "engineering.logs.explain",
        "engineering.vps.why_down",
      ]) {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBeDefined();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("never exposes a configured release-state path over MCP via app.health", async () => {
    const secretPath = "C:\\ops\\hidden-9f2a\\release-state.json";
    const server = buildServer({
      applicationDeploymentAdapter: createReleaseStateFileAdapter({ path: secretPath }),
    });
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "engineering.app.health", arguments: {} });
      expect(result.isError).toBeFalsy();
      const text = JSON.stringify(result);
      expect(text).not.toContain("hidden-9f2a");
      expect(text).not.toContain("release-state.json");
      const parsed = appHealthOutputSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("UNAVAILABLE");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});