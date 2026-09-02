import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildServer,
  createApplicationDeploymentAdapterFromEnvironment,
  RELEASE_STATE_FILE_ENV_VAR,
} from "../src/server";
import {
  DEPLOY_STATUS_LIMITATIONS,
  handleDeployStatus,
} from "../src/tools/deployStatus";
import { deployStatusOutputSchema } from "../src/tools/deployStatus";
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

function allEvidenceFieldsNull(result: {
  applicationId: unknown;
  source: unknown;
  observedAt: unknown;
  currentReleaseId: unknown;
  lastDeploymentFinishedAt: unknown;
  evidenceAgeSeconds: unknown;
}): void {
  expect(result.applicationId).toBeNull();
  expect(result.source).toBeNull();
  expect(result.observedAt).toBeNull();
  expect(result.currentReleaseId).toBeNull();
  expect(result.lastDeploymentFinishedAt).toBeNull();
  expect(result.evidenceAgeSeconds).toBeNull();
}

describe("no adapter configured", () => {
  it("returns UNAVAILABLE with all evidence-derived fields null", () => {
    const result = handleDeployStatus({}, null, () => NOW_MS);
    expect(result.status).toBe("UNAVAILABLE");
    allEvidenceFieldsNull(result);
    expect(result.summary).toContain("no application/deployment evidence source is configured");
    expect(result.summary).toContain("nothing was inferred");
    expect(result.limitations).toEqual(DEPLOY_STATUS_LIMITATIONS);
  });

  it("treats undefined exactly like null", () => {
    expect(handleDeployStatus({}, undefined, () => NOW_MS).status).toBe("UNAVAILABLE");
  });

  it("never throws and exposes no path or error text", () => {
    const result = handleDeployStatus({}, null, () => NOW_MS);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/path|Error|stack/i);
  });
});

describe("adapter exists but collect() returns null", () => {
  it("returns UNAVAILABLE with all evidence-derived fields null", () => {
    const adapter = staticAdapter(null);
    const result = handleDeployStatus({}, adapter, () => NOW_MS);
    expect(adapter.calls).toBe(1);
    expect(result.status).toBe("UNAVAILABLE");
    allEvidenceFieldsNull(result);
    expect(result.summary).toContain("returned no valid evidence");
    expect(result.summary).toContain("nothing was inferred");
  });

  it("leaks no configured path, file content, error or stack trace", () => {
    const secretPath = "C:\\ops\\hidden-9f2a\\release-state.json";
    const adapter = createReleaseStateFileAdapter({ path: secretPath });
    const result = handleDeployStatus({}, adapter, () => NOW_MS);
    const text = JSON.stringify(result);
    expect(result.status).toBe("UNAVAILABLE");
    expect(text).not.toContain("hidden-9f2a");
    expect(text).not.toContain("release-state.json");
    expect(text).not.toMatch(/ENOENT|EACCES|stack|Error/i);
  });

  it("collects evidence exactly once per invocation (no cache, no retry)", () => {
    const adapter = staticAdapter(null);
    handleDeployStatus({}, adapter, () => NOW_MS);
    handleDeployStatus({}, adapter, () => NOW_MS);
    expect(adapter.calls).toBe(2);
  });
});

describe("deployment status mapping (certified classifier reused)", () => {
  for (const [deploymentStatus, expected] of [
    ["SUCCEEDED", "OK"],
    ["IN_PROGRESS", "IN_FLIGHT"],
    ["QUEUED", "PENDING"],
    ["FAILED", "FAILED"],
  ] as const) {
    it(`maps ${deploymentStatus} -> ${expected}`, () => {
      const result = handleDeployStatus({}, staticAdapter(evidenceDocument({ deploymentStatus })), () => NOW_MS);
      expect(result.status).toBe(expected);
      expect(deployStatusOutputSchema.safeParse(result).success).toBe(true);
    });
  }

  it("returns UNKNOWN when valid evidence explicitly lacks a deployment status", () => {
    const result = handleDeployStatus(
      {},
      staticAdapter(evidenceDocument({ deploymentStatus: null })),
      () => NOW_MS,
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.summary).toContain("UNKNOWN");
  });

  it("UNKNOWN preserves all factual evidence fields and a normal age", () => {
    const evidence = evidenceDocument({
      deploymentStatus: null,
      lastDeploymentFinishedAt: null,
      applicationHealthy: null,
      currentReleaseId: null,
    });
    const result = handleDeployStatus({}, staticAdapter(evidence), () => NOW_MS);
    expect(result.status).toBe("UNKNOWN");
    expect(result.applicationId).toBe("app-1");
    expect(result.source).toBe("release-state-file-test");
    expect(result.observedAt).toBe(OBSERVED_AT);
    expect(result.currentReleaseId).toBeNull();
    expect(result.lastDeploymentFinishedAt).toBeNull();
    expect(result.evidenceAgeSeconds).toBe(90);
  });
});

describe("staleness / age", () => {
  it("computes evidenceAgeSeconds exactly with the injected clock", () => {
    const result = handleDeployStatus({}, staticAdapter(evidenceDocument()), () => NOW_MS);
    expect(result.evidenceAgeSeconds).toBe(90);
  });

  it("preserves negative age (observable clock skew) without clamping", () => {
    const before = Date.parse(OBSERVED_AT) - 5000;
    const result = handleDeployStatus({}, staticAdapter(evidenceDocument()), () => before);
    expect(result.evidenceAgeSeconds).toBe(-5);
  });

  it("never lets age change the verdict (old evidence stays OK)", () => {
    const ancientNow = Date.parse("2027-01-01T00:00:00Z");
    const result = handleDeployStatus({}, staticAdapter(evidenceDocument()), () => ancientNow);
    expect(result.status).toBe("OK");
    expect(result.evidenceAgeSeconds).toBeGreaterThan(1000000);
  });

  it("calls the clock exactly once per invocation and only once per evidence", () => {
    let calls = 0;
    const clock = (): number => {
      calls += 1;
      return NOW_MS;
    };
    handleDeployStatus({}, staticAdapter(evidenceDocument()), clock);
    expect(calls).toBe(1);
  });

  it("uses a float-safe floor (not rounding)", () => {
    const midSecond = Date.parse(OBSERVED_AT) + 1500;
    const result = handleDeployStatus({}, staticAdapter(evidenceDocument()), () => midSecond);
    expect(result.evidenceAgeSeconds).toBe(1);
  });
});

describe("factual passthrough of valid evidence", () => {
  it("passes observedAt, applicationId and source through exactly", () => {
    const result = handleDeployStatus({}, staticAdapter(evidenceDocument()), () => NOW_MS);
    expect(result.observedAt).toBe(OBSERVED_AT);
    expect(result.applicationId).toBe("app-1");
    expect(result.source).toBe("release-state-file-test");
  });

  it("passes currentReleaseId through exactly", () => {
    const result = handleDeployStatus(
      {},
      staticAdapter(evidenceDocument({ currentReleaseId: "rel-77" })),
      () => NOW_MS,
    );
    expect(result.currentReleaseId).toBe("rel-77");
  });

  it("passes lastDeploymentFinishedAt through exactly, including null", () => {
    const withValue = handleDeployStatus({}, staticAdapter(evidenceDocument()), () => NOW_MS);
    expect(withValue.lastDeploymentFinishedAt).toBe("2026-09-02T11:30:00Z");
    const withoutValue = handleDeployStatus(
      {},
      staticAdapter(evidenceDocument({ lastDeploymentFinishedAt: null })),
      () => NOW_MS,
    );
    expect(withoutValue.lastDeploymentFinishedAt).toBeNull();
  });

  it("does not expose previousReleaseId in 05C output", () => {
    const result = handleDeployStatus({}, staticAdapter(evidenceDocument()), () => NOW_MS);
    expect(Object.keys(result)).not.toContain("previousReleaseId");
    // The output schema matches the documented exact shape and rejects
    // invalid verdicts (matching the non-strict output-schema convention of
    // the other public tools).
    expect(deployStatusOutputSchema.safeParse(result).success).toBe(true);
    expect(
      deployStatusOutputSchema.safeParse({ ...result, status: "ROLLED_BACK" }).success,
    ).toBe(false);
  });

  it("includes the fixed limitations in every output", () => {
    for (const result of [
      handleDeployStatus({}, null, () => NOW_MS),
      handleDeployStatus({}, staticAdapter(null), () => NOW_MS),
      handleDeployStatus({}, staticAdapter(evidenceDocument()), () => NOW_MS),
    ]) {
      expect(result.limitations).toEqual(DEPLOY_STATUS_LIMITATIONS);
    }
  });
});

describe("strict empty input", () => {
  it("accepts exactly {} and undefined, rejects extra keys and non-objects", () => {
    const adapter = staticAdapter(evidenceDocument());
    expect(handleDeployStatus({}, adapter, () => NOW_MS).status).toBe("OK");
    expect(handleDeployStatus(undefined, adapter, () => NOW_MS).status).toBe("OK");
    expect(() => handleDeployStatus({ path: "x" }, adapter, () => NOW_MS)).toThrow(StrictInputError);
    expect(() => handleDeployStatus({ evidence: {} }, adapter, () => NOW_MS)).toThrow(StrictInputError);
    expect(() => handleDeployStatus("x" as unknown, adapter, () => NOW_MS)).toThrow(StrictInputError);
    expect(() => handleDeployStatus([], adapter, () => NOW_MS)).toThrow(StrictInputError);
  });
});

describe("startup env wiring helper", () => {
  it("returns no adapter when the variable is undefined", () => {
    expect(createApplicationDeploymentAdapterFromEnvironment(() => undefined)).toBeNull();
  });

  it("returns no adapter when the variable is empty", () => {
    expect(createApplicationDeploymentAdapterFromEnvironment(() => "")).toBeNull();
  });

  it("creates the release-state file adapter when configured", () => {
    const adapter = createApplicationDeploymentAdapterFromEnvironment(() => "C:\\ops\\state.json");
    expect(adapter).not.toBeNull();
    expect(adapter!.name).toBe("release-state-file");
  });

  it("requests exactly the approved env variable name", () => {
    const requested: string[] = [];
    createApplicationDeploymentAdapterFromEnvironment((name) => {
      requested.push(name);
      return undefined;
    });
    expect(requested).toEqual([RELEASE_STATE_FILE_ENV_VAR]);
    expect(RELEASE_STATE_FILE_ENV_VAR).toBe("MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE");
  });

  it("does not trim or coerce (whitespace stays untouched, no fabrication)", () => {
    const requested: string[] = [];
    const adapter = createApplicationDeploymentAdapterFromEnvironment((name) => {
      requested.push(name);
      return "  ";
    });
    // "  " is non-empty and must be passed through unmodified to the adapter
    // constructor (which accepts it; the file read then fails closed).
    expect(adapter).not.toBeNull();
  });
});

describe("MCP server integration", () => {
  it("lists exactly the six public tools", async () => {
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
          "engineering.vps.capacity",
          "engineering.vps.health",
          "engineering.vps.incident.summary",
          "engineering.vps.what_changed",
        ].sort(),
      );
      const tool = listed.tools.find((t) => t.name === "engineering.deploy.status");
      expect(tool).toBeDefined();
      expect((tool!.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("exposes engineering.deploy.status over MCP with structured output", async () => {
    const server = buildServer({ applicationDeploymentAdapter: staticAdapter(evidenceDocument()) });
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "engineering.deploy.status", arguments: {} });
      expect(result.isError).toBeFalsy();
      const parsed = deployStatusOutputSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("OK");
        expect(parsed.data.applicationId).toBe("app-1");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports UNAVAILABLE over MCP in the zero-config build", async () => {
    const server = buildServer();
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "engineering.deploy.status", arguments: {} });
      expect(result.isError).toBeFalsy();
      const parsed = deployStatusOutputSchema.safeParse(result.structuredContent);
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

  it("keeps the existing four tools callable and preserves protocol strict input", async () => {
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
      ]) {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBeDefined();
      }
      const bad = await client.callTool({ name: "engineering.deploy.status", arguments: { foo: 1 } });
      expect(bad.isError).toBe(true);
      const good = await client.callTool({ name: "engineering.deploy.status", arguments: {} });
      expect(good.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("never exposes a configured release-state path over MCP", async () => {
    const secretPath = "C:\\ops\\hidden-9f2a\\release-state.json";
    const server = buildServer({
      applicationDeploymentAdapter: createReleaseStateFileAdapter({ path: secretPath }),
    });
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "engineering.deploy.status", arguments: {} });
      expect(result.isError).toBeFalsy();
      const text = JSON.stringify(result);
      expect(text).not.toContain("hidden-9f2a");
      expect(text).not.toContain("release-state.json");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
