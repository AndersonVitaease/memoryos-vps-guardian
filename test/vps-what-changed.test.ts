import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../src/server";
import {
  createVpsWhatChangedTool,
  LOAD_PER_CPU_DELTA_THRESHOLD,
  MEMORY_FREE_DELTA_FRACTION_THRESHOLD,
  vpsWhatChangedOutputSchema,
} from "../src/tools/vpsWhatChanged";
import { StrictInputError, vpsHealthOutputSchema } from "../src/tools/vpsHealth";
import { vpsCapacityOutputSchema } from "../src/tools/vpsCapacity";
import type { SystemHealthAdapter, VpsHealthEvidence } from "../src/adapters/systemHealth";

// Base snapshot: total 10_000 bytes -> 1% of total = 100 bytes; load per CPU = 0.5.
const CALM: VpsHealthEvidence = {
  uptimeSeconds: 100_000,
  cpuCount: 2,
  loadAverage1m: 1,
  memoryTotalBytes: 10_000,
  memoryFreeBytes: 5_000,
};

/** Static evidence adapter whose current evidence can be changed between calls. */
function makeAdapter() {
  const state: { evidence: VpsHealthEvidence } = { evidence: CALM };
  const adapter: SystemHealthAdapter = {
    name: "static-test-adapter",
    collect: () => state.evidence,
  };
  return {
    adapter,
    set(next: VpsHealthEvidence) {
      state.evidence = next;
    },
  };
}

function makeTool() {
  const env = makeAdapter();
  return { tool: createVpsWhatChangedTool(env.adapter), set: env.set };
}

function assertIsoUtc(value: string): void {
  expect(value.endsWith("Z")).toBe(true);
  expect(Number.isNaN(Date.parse(value))).toBe(false);
}

describe("first observation (baseline)", () => {
  it("returns BASELINE_CREATED with an empty changes list on the first call", () => {
    const { tool } = makeTool();
    const result = tool.handle({});
    expect(result.status).toBe("BASELINE_CREATED");
    expect(result.changes).toEqual([]);
    expect(result.observationsSinceBaseline).toBe(1);
  });

  it("never invents history: the summary states no previous observation existed", () => {
    const { tool } = makeTool();
    const result = tool.handle({});
    expect(result.summary).toMatch(/no previous observation existed/i);
    expect(result.summary).toMatch(/before this baseline/i);
  });

  it("baselineCapturedAt is a valid ISO UTC timestamp", () => {
    const { tool } = makeTool();
    const result = tool.handle({});
    expect(result.baselineCapturedAt).not.toBeNull();
    assertIsoUtc(result.baselineCapturedAt as string);
  });
});

describe("no significant change", () => {
  it("returns NO_CHANGE when the second observation is identical", () => {
    const { tool } = makeTool();
    tool.handle({});
    const result = tool.handle({});
    expect(result.status).toBe("NO_CHANGE");
    expect(result.changes).toEqual([]);
    expect(result.observationsSinceBaseline).toBe(2);
  });

  it("NO_CHANGE means only 'no change above thresholds since the previous observation of this process'", () => {
    const { tool } = makeTool();
    tool.handle({});
    const result = tool.handle({});
    expect(result.summary).toMatch(
      /^NO_CHANGE: no observed evidence changed above the documented thresholds since the previous observation of this process\./,
    );
  });

  it("free memory delta just below 1% of total is NOT a change (99 < 100)", () => {
    const { tool, set } = makeTool();
    tool.handle({});
    set({ ...CALM, memoryFreeBytes: 5_099 }); // delta 99 < 100 (1% of 10_000)
    const result = tool.handle({});
    expect(result.status).toBe("NO_CHANGE");
    expect(result.changes).toEqual([]);
    expect(MEMORY_FREE_DELTA_FRACTION_THRESHOLD * 10_000).toBe(100);
  });
});

describe("cpuCount change", () => {
  it("reports CHANGED with real before/after when CPU count differs", () => {
    const { tool, set } = makeTool();
    tool.handle({});
    set({ ...CALM, cpuCount: 4 });
    const result = tool.handle({});
    expect(result.status).toBe("CHANGED");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].category).toBe("cpuCount");
    expect(result.changes[0].before).toBe(2);
    expect(result.changes[0].after).toBe(4);
  });
});

describe("reboot detection", () => {
  it("reports CHANGED (category reboot) when uptime decreased, without claiming a cause", () => {
    const { tool, set } = makeTool();
    tool.handle({});
    set({ ...CALM, uptimeSeconds: 50_000 });
    const result = tool.handle({});
    expect(result.status).toBe("CHANGED");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].category).toBe("reboot");
    expect(result.changes[0].before).toBe(100_000);
    expect(result.changes[0].after).toBe(50_000);
    expect(result.changes[0].description).toMatch(
      /^Observed system uptime decreased since the previous observation/,
    );
    expect(result.changes[0].description).not.toMatch(/because|cause|crash|failure|deploy/i);
  });
});

describe("memory change (raw values)", () => {
  it("reports CHANGED when the free memory delta is strictly above 1% of total", () => {
    const { tool, set } = makeTool();
    tool.handle({});
    set({ ...CALM, memoryFreeBytes: 4_899 }); // delta 101 > 100 (1% of 10_000)
    const result = tool.handle({});
    expect(result.status).toBe("CHANGED");
    expect(result.changes[0].category).toBe("memory");
    expect(result.changes[0].before).toBe(5_000);
    expect(result.changes[0].after).toBe(4_899);
  });

  it("does NOT report a change when the delta is exactly 1% of total", () => {
    const { tool, set } = makeTool();
    tool.handle({});
    set({ ...CALM, memoryFreeBytes: 4_900 }); // delta 100 == 1% of 10_000 (not >)
    const result = tool.handle({});
    expect(result.status).toBe("NO_CHANGE");
    expect(result.changes).toEqual([]);
  });

  it("skips the memory comparison when memoryTotalBytes changed (UNKNOWN, no fabricated diff)", () => {
    const { tool, set } = makeTool();
    tool.handle({});
    set({ ...CALM, memoryTotalBytes: 20_000, memoryFreeBytes: 10_000 }); // same 50% ratio
    const result = tool.handle({});
    expect(result.status).toBe("UNKNOWN");
    expect(result.changes).toEqual([]);
    expect(result.summary).toContain("memoryTotalBytes");
  });

  it("still reports other real changes when memory is incomparable (CHANGED, memory skipped)", () => {
    const { tool, set } = makeTool();
    tool.handle({});
    set({ ...CALM, cpuCount: 4, memoryTotalBytes: 20_000, memoryFreeBytes: 10_000 });
    const result = tool.handle({});
    expect(result.status).toBe("CHANGED");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].category).toBe("cpuCount");
    expect(result.summary).toContain("skipped");
  });
});

describe("cpu load-per-CPU change (raw values)", () => {
  it("reports CHANGED when the load-per-CPU delta is strictly above 0.5", () => {
    const { tool, set } = makeTool();
    tool.handle({});
    set({ ...CALM, loadAverage1m: 2.2 }); // per CPU: 0.5 -> 1.1, delta 0.6
    const result = tool.handle({});
    expect(result.status).toBe("CHANGED");
    expect(result.changes[0].category).toBe("cpu");
    expect(result.changes[0].before).toBe(0.5);
    expect(result.changes[0].after).toBe(1.1);
  });

  it("does NOT report a change when the delta is exactly 0.5", () => {
    const { tool, set } = makeTool();
    tool.handle({});
    set({ ...CALM, loadAverage1m: 2 }); // per CPU: 0.5 -> 1.0, delta exactly 0.5
    const result = tool.handle({});
    expect(result.status).toBe("NO_CHANGE");
    expect(result.changes).toEqual([]);
    expect(LOAD_PER_CPU_DELTA_THRESHOLD).toBe(0.5);
  });

  it("compares raw unrounded values: raw delta 0.53 is CHANGED (rounded delta 0.5 would be NO_CHANGE)", () => {
    const { tool, set } = makeTool();
    set({ ...CALM, cpuCount: 1, loadAverage1m: 2.21 });
    tool.handle({});
    set({ ...CALM, cpuCount: 1, loadAverage1m: 2.74 }); // raw delta 0.53; round1 delta would be 0.5
    const result = tool.handle({});
    expect(result.status).toBe("CHANGED");
    expect(result.changes[0].category).toBe("cpu");
    expect(result.changes[0].before).toBe(2.21);
    expect(result.changes[0].after).toBe(2.74);
  });
});

describe("unknown evidence", () => {
  it("returns UNKNOWN (no baseline) when the first observation is invalid; nothing is fabricated", () => {
    const { tool, set } = makeTool();
    set({
      uptimeSeconds: null,
      cpuCount: null,
      loadAverage1m: null,
      memoryTotalBytes: null,
      memoryFreeBytes: null,
    });
    const result = tool.handle({});
    expect(result.status).toBe("UNKNOWN");
    expect(result.baselineCapturedAt).toBeNull();
    expect(result.observationsSinceBaseline).toBe(0);
    expect(result.changes).toEqual([]);
  });

  it("returns UNKNOWN on inconsistent evidence (free > total)", () => {
    const { tool, set } = makeTool();
    set({ ...CALM, memoryFreeBytes: 11_000 });
    const result = tool.handle({});
    expect(result.status).toBe("UNKNOWN");
    expect(result.changes).toEqual([]);
  });

  it("mid-session invalid evidence: UNKNOWN keeps the previous observation and does not advance the counter", () => {
    const { tool, set } = makeTool();
    tool.handle({}); // baseline, obs 1
    set({ ...CALM, cpuCount: 0 }); // invalid evidence
    const bad = tool.handle({});
    expect(bad.status).toBe("UNKNOWN");
    expect(bad.changes).toEqual([]);
    expect(bad.observationsSinceBaseline).toBe(1); // unchanged
    expect(bad.baselineCapturedAt).not.toBeNull();
    set({ ...CALM }); // identical to the baseline observation
    const good = tool.handle({});
    expect(good.status).toBe("NO_CHANGE"); // compared against the preserved previous observation
    expect(good.observationsSinceBaseline).toBe(2); // UNKNOWN call did not advance the counter
  });
});

describe("observation counter and session scope", () => {
  it("counts successful observations: 1, 2, 3; UNKNOWN calls do not advance it", () => {
    const { tool, set } = makeTool();
    expect(tool.handle({}).observationsSinceBaseline).toBe(1);
    expect(tool.handle({}).observationsSinceBaseline).toBe(2);
    expect(tool.handle({}).observationsSinceBaseline).toBe(3);
    set({ ...CALM, memoryFreeBytes: null });
    expect(tool.handle({}).observationsSinceBaseline).toBe(3); // UNKNOWN: no advance
    set({ ...CALM });
    expect(tool.handle({}).observationsSinceBaseline).toBe(4);
  });

  it("baselineCapturedAt stays stable within the session", () => {
    const { tool } = makeTool();
    const first = tool.handle({});
    const second = tool.handle({});
    const third = tool.handle({});
    expect(second.baselineCapturedAt).toBe(first.baselineCapturedAt);
    expect(third.baselineCapturedAt).toBe(first.baselineCapturedAt);
    assertIsoUtc(first.baselineCapturedAt as string);
  });

  it("a new instance starts a new baseline (no global/module state)", () => {
    const env = makeAdapter();
    const a = createVpsWhatChangedTool(env.adapter);
    const b = createVpsWhatChangedTool(env.adapter);
    const firstA = a.handle({});
    expect(firstA.status).toBe("BASELINE_CREATED");
    expect(a.handle({}).status).toBe("NO_CHANGE");
    const firstB = b.handle({}); // same adapter evidence, fresh instance
    expect(firstB.status).toBe("BASELINE_CREATED");
    expect(firstB.observationsSinceBaseline).toBe(1);
  });
});

describe("strict empty input (function boundary)", () => {
  it("accepts exactly {} and rejects any other input", () => {
    const { tool } = makeTool();
    expect(() => tool.handle({ extra: 1 })).toThrow(StrictInputError);
    expect(() => tool.handle([1, 2])).toThrow(StrictInputError);
    expect(() => tool.handle("x")).toThrow(StrictInputError);
    expect(tool.handle({}).status).toBe("BASELINE_CREATED");
  });
});

describe("vps what_changed output schema", () => {
  it("matches the documented structured output exactly and rejects invalid outputs", () => {
    const { tool } = makeTool();
    const baseline = tool.handle({});
    expect(Object.keys(baseline).sort()).toEqual([
      "baselineCapturedAt",
      "changes",
      "observationsSinceBaseline",
      "status",
      "summary",
    ]);
    expect(vpsWhatChangedOutputSchema.safeParse(baseline).success).toBe(true);

    const { tool: tool2, set } = makeTool();
    tool2.handle({});
    set({ ...CALM, cpuCount: 4 });
    const changed = tool2.handle({});
    expect(Object.keys(changed.changes[0]).sort()).toEqual([
      "after",
      "before",
      "category",
      "description",
    ]);
    expect(vpsWhatChangedOutputSchema.safeParse(changed).success).toBe(true);
    expect(
      vpsWhatChangedOutputSchema.safeParse({ status: "MAGIC", summary: "x" }).success,
    ).toBe(false);
    expect(
      vpsWhatChangedOutputSchema.safeParse({ ...changed, changes: [{ category: "files" }] })
        .success,
    ).toBe(false);
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
        "engineering.deploy.ready",
        "engineering.deploy.status",
        "engineering.docker.health",
        "engineering.logs.explain",
        "engineering.vps.capacity",
        "engineering.vps.health",
        "engineering.vps.incident.summary",
        "engineering.vps.what_changed",
        "engineering.vps.why_down",
      ]);
      for (const tool of listed.tools) {
        expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("executes engineering.vps.what_changed over the protocol: baseline, second call, extra keys rejected", async () => {
    const server = buildServer();
    const client = new Client({ name: "what-changed-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const bad = await client.callTool({
        name: "engineering.vps.what_changed",
        arguments: { foo: "bar" },
      });
      expect(bad.isError).toBe(true);

      const first = await client.callTool({ name: "engineering.vps.what_changed", arguments: {} });
      expect(first.isError).toBeFalsy();
      const firstParsed = vpsWhatChangedOutputSchema.safeParse(first.structuredContent);
      expect(firstParsed.success).toBe(true);
      if (firstParsed.success) {
        expect(firstParsed.data.status).toBe("BASELINE_CREATED");
        expect(firstParsed.data.changes).toEqual([]);
        expect(firstParsed.data.observationsSinceBaseline).toBe(1);
      }

      const second = await client.callTool({
        name: "engineering.vps.what_changed",
        arguments: {},
      });
      expect(second.isError).toBeFalsy();
      const secondParsed = vpsWhatChangedOutputSchema.safeParse(second.structuredContent);
      expect(secondParsed.success).toBe(true);
      if (secondParsed.success) {
        expect(["CHANGED", "NO_CHANGE", "UNKNOWN"]).toContain(secondParsed.data.status);
        expect(secondParsed.data.observationsSinceBaseline).toBe(2);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("no regression: engineering.vps.health and engineering.vps.capacity keep working", async () => {
    const server = buildServer();
    const client = new Client({ name: "regression-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const health = await client.callTool({ name: "engineering.vps.health", arguments: {} });
      expect(health.isError).toBeFalsy();
      const healthParsed = vpsHealthOutputSchema.safeParse(health.structuredContent);
      expect(healthParsed.success).toBe(true);
      if (healthParsed.success) {
        expect(["HEALTHY", "DEGRADED", "UNKNOWN"]).toContain(healthParsed.data.status);
      }

      const capacity = await client.callTool({ name: "engineering.vps.capacity", arguments: {} });
      expect(capacity.isError).toBeFalsy();
      const capacityParsed = vpsCapacityOutputSchema.safeParse(capacity.structuredContent);
      expect(capacityParsed.success).toBe(true);
      if (capacityParsed.success) {
        expect(["OK", "PRESSURED", "UNKNOWN"]).toContain(capacityParsed.data.status);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
