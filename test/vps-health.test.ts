import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../src/server";
import {
  assessVpsHealth,
  handleVpsHealth,
  StrictInputError,
  vpsHealthOutputSchema,
  MEMORY_USED_PERCENT_DEGRADED_THRESHOLD,
  LOAD_PER_CPU_DEGRADED_THRESHOLD,
} from "../src/tools/vpsHealth";
import type { SystemHealthAdapter, VpsHealthEvidence } from "../src/adapters/systemHealth";

const GIB = 1024 * 1024 * 1024;

const HEALTHY: VpsHealthEvidence = {
  uptimeSeconds: 3_600_000,
  cpuCount: 4,
  loadAverage1m: 1.2,
  memoryTotalBytes: 16 * GIB,
  memoryFreeBytes: 8 * GIB,
};

function staticAdapter(evidence: VpsHealthEvidence): SystemHealthAdapter & { calls: number } {
  const adapter = {
    name: "static-test",
    calls: 0,
    collect(): VpsHealthEvidence {
      adapter.calls += 1;
      return evidence;
    },
  };
  return adapter;
}

describe("assessVpsHealth (deterministic classification)", () => {
  it("returns HEALTHY with normal evidence", () => {
    const result = assessVpsHealth(HEALTHY);
    expect(result.status).toBe("HEALTHY");
    expect(result.evidence.memoryUsedPercent).toBe(50);
    expect(result.evidence.cpuCount).toBe(4);
    expect(result.evidence.uptimeSeconds).toBe(3_600_000);
  });

  it("returns DEGRADED on high memory pressure", () => {
    const evidence: VpsHealthEvidence = { ...HEALTHY, memoryFreeBytes: Math.floor(16 * GIB * 0.05) };
    const result = assessVpsHealth(evidence);
    expect(result.status).toBe("DEGRADED");
    expect(result.evidence.memoryUsedPercent).toBeGreaterThan(MEMORY_USED_PERCENT_DEGRADED_THRESHOLD);
    expect(result.summary).toContain("memory");
  });

  it("returns DEGRADED on high load per CPU", () => {
    const evidence: VpsHealthEvidence = { ...HEALTHY, cpuCount: 2, loadAverage1m: 10 };
    const result = assessVpsHealth(evidence);
    expect(result.status).toBe("DEGRADED");
    expect(result.summary).toContain("load");
    expect(result.evidence.loadAverage1m! / result.evidence.cpuCount!).toBeGreaterThan(
      LOAD_PER_CPU_DEGRADED_THRESHOLD,
    );
  });

  it("compares the raw unrounded load ratio (rounding is display-only): 2.04/1 -> DEGRADED", () => {
    const evidence: VpsHealthEvidence = { ...HEALTHY, cpuCount: 1, loadAverage1m: 2.04 };
    const result = assessVpsHealth(evidence);
    expect(result.status).toBe("DEGRADED");
  });

  it("compares raw memory used percent (rounding is display-only): 90.04% -> DEGRADED, exactly 90% -> HEALTHY", () => {
    const above = assessVpsHealth({ ...HEALTHY, memoryTotalBytes: 10000, memoryFreeBytes: 996 });
    expect(above.status).toBe("DEGRADED"); // raw 90.04% used (display rounds to 90.0)

    const at = assessVpsHealth({ ...HEALTHY, memoryTotalBytes: 10000, memoryFreeBytes: 1000 });
    expect(at.status).toBe("HEALTHY"); // exactly 90% is not "above 90%"
    expect(at.evidence.memoryUsedPercent).toBe(90);
  });
  it("returns UNKNOWN when essential evidence is unavailable (no fabricated values)", () => {
    const result = assessVpsHealth({ ...HEALTHY, memoryTotalBytes: null, memoryFreeBytes: null });
    expect(result.status).toBe("UNKNOWN");
    expect(result.evidence.memoryTotalBytes).toBeNull();
    expect(result.evidence.memoryUsedPercent).toBeNull();
  });

  it("returns UNKNOWN on inconsistent evidence (free > total)", () => {
    const result = assessVpsHealth({ ...HEALTHY, memoryFreeBytes: 17 * GIB });
    expect(result.status).toBe("UNKNOWN");
  });
});

describe("output schema", () => {
  it("matches the documented structured output exactly and rejects invalid outputs", () => {
    const result = assessVpsHealth(HEALTHY);
    expect(Object.keys(result).sort()).toEqual(["evidence", "status", "summary"]);
    expect(Object.keys(result.evidence).sort()).toEqual([
      "cpuCount",
      "loadAverage1m",
      "memoryFreeBytes",
      "memoryTotalBytes",
      "memoryUsedPercent",
      "uptimeSeconds",
    ]);
    expect(vpsHealthOutputSchema.safeParse(result).success).toBe(true);
    expect(
      vpsHealthOutputSchema.safeParse({ status: "INVALID", summary: "x", evidence: {} }).success,
    ).toBe(false);
  });
});

describe("strict empty input", () => {
  it("accepts exactly {} and rejects any other input", () => {
    const adapter = staticAdapter(HEALTHY);
    expect(handleVpsHealth({}, adapter).status).toBe("HEALTHY");
    expect(handleVpsHealth(undefined, adapter).status).toBe("HEALTHY");
    expect(() => handleVpsHealth({ extra: 1 }, adapter)).toThrow(StrictInputError);
    expect(() => handleVpsHealth("x" as unknown, adapter)).toThrow(StrictInputError);
  });
});

describe("read-only / no side effects", () => {
  it("collects evidence exactly once per call, never mutates evidence, and is deterministic", () => {
    const adapter = staticAdapter(Object.freeze({ ...HEALTHY }));
    const first = handleVpsHealth({}, adapter);
    const second = handleVpsHealth({}, adapter);
    expect(adapter.calls).toBe(2);
    expect(first).toEqual(second);
    expect(first).toEqual(assessVpsHealth(HEALTHY));
  });
});

describe("MCP server", () => {
  it("starts, registers engineering.vps.health and executes it over the protocol", async () => {
    const server = buildServer();
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((t) => t.name === "engineering.vps.health");
      expect(tool).toBeDefined();

      const result = await client.callTool({ name: "engineering.vps.health", arguments: {} });
      expect(result.isError).toBeFalsy();
      const parsed = vpsHealthOutputSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(["HEALTHY", "DEGRADED", "UNKNOWN"]).toContain(parsed.data.status);
        expect(typeof parsed.data.summary).toBe("string");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects extra keys at the protocol layer (additionalProperties: false) and still accepts {}", async () => {
    const server = buildServer();
    const client = new Client({ name: "strict-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((t) => t.name === "engineering.vps.health");
      expect(tool).toBeDefined();
      expect((tool!.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);

      const bad = await client.callTool({ name: "engineering.vps.health", arguments: { foo: "bar" } });
      expect(bad.isError).toBe(true);

      const good = await client.callTool({ name: "engineering.vps.health", arguments: {} });
      expect(good.isError).toBeFalsy();
      expect(good.structuredContent).toBeDefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
