import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../src/server";
import {
  assessVpsCapacity,
  handleVpsCapacity,
  vpsCapacityOutputSchema,
  LOAD_PER_CPU_HIGH_THRESHOLD,
  MEMORY_USED_PERCENT_HIGH_THRESHOLD,
} from "../src/tools/vpsCapacity";
import { StrictInputError, vpsHealthOutputSchema } from "../src/tools/vpsHealth";
import type { VpsHealthEvidence } from "../src/adapters/systemHealth";

const GIB = 1024 * 1024 * 1024;

const CALM: VpsHealthEvidence = {
  uptimeSeconds: 3_600_000,
  cpuCount: 4,
  loadAverage1m: 1.2,
  memoryTotalBytes: 16 * GIB,
  memoryFreeBytes: 8 * GIB,
};

describe("assessVpsCapacity (deterministic classification)", () => {
  it("returns OK with calm evidence (both components OK)", () => {
    const result = assessVpsCapacity(CALM);
    expect(result.status).toBe("OK");
    expect(result.capacity.cpu.pressure).toBe("OK");
    expect(result.capacity.memory.pressure).toBe("OK");
    expect(result.capacity.cpu.loadPerCpu).toBe(0.3);
    expect(result.capacity.memory.usedPercent).toBe(50);
    expect(result.summary).toContain("OK");
  });

  it("returns PRESSURED on memory pressure", () => {
    const evidence: VpsHealthEvidence = { ...CALM, memoryFreeBytes: Math.floor(16 * GIB * 0.05) };
    const result = assessVpsCapacity(evidence);
    expect(result.status).toBe("PRESSURED");
    expect(result.capacity.memory.pressure).toBe("HIGH");
    expect(result.capacity.memory.usedPercent).toBeGreaterThan(MEMORY_USED_PERCENT_HIGH_THRESHOLD);
    expect(result.capacity.cpu.pressure).toBe("OK");
    expect(result.summary).toContain("memory");
  });

  it("returns PRESSURED on CPU pressure", () => {
    const evidence: VpsHealthEvidence = { ...CALM, cpuCount: 2, loadAverage1m: 10 };
    const result = assessVpsCapacity(evidence);
    expect(result.status).toBe("PRESSURED");
    expect(result.capacity.cpu.pressure).toBe("HIGH");
    expect(result.capacity.memory.pressure).toBe("OK");
    expect(result.summary).toContain("cpu");
  });

  it("returns UNKNOWN when memory evidence is unavailable (no fabricated values)", () => {
    const result = assessVpsCapacity({ ...CALM, memoryTotalBytes: null, memoryFreeBytes: null });
    expect(result.status).toBe("UNKNOWN");
    expect(result.capacity.memory.pressure).toBe("UNKNOWN");
    expect(result.capacity.memory.usedPercent).toBeNull();
    expect(result.capacity.cpu.pressure).toBe("OK");
  });

  it("returns UNKNOWN on inconsistent memory evidence (free > total)", () => {
    const result = assessVpsCapacity({ ...CALM, memoryFreeBytes: 17 * GIB });
    expect(result.status).toBe("UNKNOWN");
    expect(result.capacity.memory.pressure).toBe("UNKNOWN");
    expect(result.capacity.memory.usedPercent).toBeNull();
  });

  it("returns UNKNOWN when cpu evidence is unusable (cpuCount <= 0)", () => {
    const result = assessVpsCapacity({ ...CALM, cpuCount: 0 });
    expect(result.status).toBe("UNKNOWN");
    expect(result.capacity.cpu.pressure).toBe("UNKNOWN");
    expect(result.capacity.cpu.loadPerCpu).toBeNull();
  });

  it("compares the raw unrounded load ratio (boundary): 2.04/1 -> HIGH, exactly 2/1 -> OK", () => {
    const above = assessVpsCapacity({ ...CALM, cpuCount: 1, loadAverage1m: 2.04 });
    expect(above.status).toBe("PRESSURED");
    expect(above.capacity.cpu.pressure).toBe("HIGH");
    // display-only rounding: 2.04 renders as 2.0 but is still compared raw
    expect(above.capacity.cpu.loadPerCpu).toBe(2);

    const exactlyAt = assessVpsCapacity({ ...CALM, cpuCount: 1, loadAverage1m: LOAD_PER_CPU_HIGH_THRESHOLD });
    expect(exactlyAt.status).toBe("OK");
    expect(exactlyAt.capacity.cpu.pressure).toBe("OK");
  });

  it("memory boundary: exactly 90% used is OK, above is HIGH", () => {
    const atThreshold = assessVpsCapacity({ ...CALM, memoryTotalBytes: 1000, memoryFreeBytes: 100 });
    expect(atThreshold.capacity.memory.usedPercent).toBe(90);
    expect(atThreshold.status).toBe("OK");

    const above = assessVpsCapacity({ ...CALM, memoryTotalBytes: 1000, memoryFreeBytes: 95 });
    expect(above.capacity.memory.usedPercent).toBe(90.5);
    expect(above.status).toBe("PRESSURED");
  });

  it("describes current state only (no future prediction or upgrade advice in summary)", () => {
    const pressured = assessVpsCapacity({ ...CALM, memoryFreeBytes: 0 });
    expect(pressured.summary).toMatch(/^PRESSURED: /);
    expect(pressured.summary.toLowerCase()).not.toContain("will");
    expect(pressured.summary.toLowerCase()).not.toContain("upgrade");
    expect(pressured.summary.toLowerCase()).not.toContain("minutes");
  });
});

describe("vps capacity output schema", () => {
  it("matches the documented structured output exactly and rejects invalid outputs", () => {
    const result = assessVpsCapacity(CALM);
    expect(Object.keys(result).sort()).toEqual(["capacity", "status", "summary"]);
    expect(Object.keys(result.capacity).sort()).toEqual(["cpu", "memory"]);
    expect(Object.keys(result.capacity.cpu).sort()).toEqual([
      "cpuCount",
      "loadAverage1m",
      "loadPerCpu",
      "pressure",
    ]);
    expect(Object.keys(result.capacity.memory).sort()).toEqual([
      "freeBytes",
      "pressure",
      "totalBytes",
      "usedPercent",
    ]);
    expect(vpsCapacityOutputSchema.safeParse(result).success).toBe(true);
    expect(
      vpsCapacityOutputSchema.safeParse({ status: "FAILING", summary: "x", capacity: {} }).success,
    ).toBe(false);
  });
});

describe("strict empty input (function boundary)", () => {
  it("accepts exactly {} and rejects any other input", () => {
    expect(handleVpsCapacity({}, { name: "static", collect: () => CALM }).status).toBe("OK");
    expect(() => handleVpsCapacity({ extra: 1 }, { name: "static", collect: () => CALM })).toThrow(
      StrictInputError,
    );
  });
});

describe("MCP server (four tools)", () => {
  it("registers exactly the four implemented tools, all strict-empty", async () => {
    const server = buildServer();
    const client = new Client({ name: "list-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "engineering.app.health",
        "engineering.deploy.status",
        "engineering.vps.capacity",
        "engineering.vps.health",
        "engineering.vps.incident.summary",
        "engineering.vps.what_changed",
      ]);
      for (const tool of listed.tools) {
        expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("executes engineering.vps.capacity over the protocol and rejects extra keys", async () => {
    const server = buildServer();
    const client = new Client({ name: "capacity-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const bad = await client.callTool({ name: "engineering.vps.capacity", arguments: { foo: "bar" } });
      expect(bad.isError).toBe(true);

      const good = await client.callTool({ name: "engineering.vps.capacity", arguments: {} });
      expect(good.isError).toBeFalsy();
      const parsed = vpsCapacityOutputSchema.safeParse(good.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(["OK", "PRESSURED", "UNKNOWN"]).toContain(parsed.data.status);
        expect(typeof parsed.data.summary).toBe("string");
        expect(Object.keys(parsed.data.capacity).sort()).toEqual(["cpu", "memory"]);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("no regression: engineering.vps.health keeps working alongside the new tool", async () => {
    const server = buildServer();
    const client = new Client({ name: "regression-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const bad = await client.callTool({ name: "engineering.vps.health", arguments: { foo: "bar" } });
      expect(bad.isError).toBe(true);

      const good = await client.callTool({ name: "engineering.vps.health", arguments: {} });
      expect(good.isError).toBeFalsy();
      const parsed = vpsHealthOutputSchema.safeParse(good.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(["HEALTHY", "DEGRADED", "UNKNOWN"]).toContain(parsed.data.status);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
