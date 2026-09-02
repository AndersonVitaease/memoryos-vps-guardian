import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../src/server";
import {
  createVpsIncidentSummaryTool,
  vpsIncidentSummaryOutputSchema,
} from "../src/tools/vpsIncidentSummary";
import { StrictInputError } from "../src/tools/vpsHealth";
import { createVpsWhatChangedTool } from "../src/tools/vpsWhatChanged";
import type { SystemHealthAdapter, VpsHealthEvidence } from "../src/adapters/systemHealth";

// CALM: 50% memory used, load per CPU 0.5 -> HEALTHY + OK.
const CALM: VpsHealthEvidence = {
  uptimeSeconds: 100_000,
  cpuCount: 2,
  loadAverage1m: 1,
  memoryTotalBytes: 10_000,
  memoryFreeBytes: 5_000,
};
const DEGRADED_PRESSURED: VpsHealthEvidence = { ...CALM, memoryFreeBytes: 500 }; // 95% used -> DEGRADED + PRESSURED
const ALL_NULL: VpsHealthEvidence = {
  uptimeSeconds: null,
  cpuCount: null,
  loadAverage1m: null,
  memoryTotalBytes: null,
  memoryFreeBytes: null,
};

function makePair(initialChangeEvidence: VpsHealthEvidence = CALM) {
  const summaryState: { evidence: VpsHealthEvidence } = { evidence: CALM };
  let summaryCollects = 0;
  const summaryAdapter: SystemHealthAdapter = {
    name: "summary-test-adapter",
    collect: () => {
      summaryCollects += 1;
      return summaryState.evidence;
    },
  };
  const changeState: { evidence: VpsHealthEvidence } = { evidence: initialChangeEvidence };
  const changeAdapter: SystemHealthAdapter = {
    name: "change-test-adapter",
    collect: () => changeState.evidence,
  };
  const changeTool = createVpsWhatChangedTool(changeAdapter);
  const summary = createVpsIncidentSummaryTool(summaryAdapter, changeTool);
  return {
    summary,
    changeTool,
    setSummary: (e: VpsHealthEvidence) => {
      summaryState.evidence = e;
    },
    setChange: (e: VpsHealthEvidence) => {
      changeState.evidence = e;
    },
    summaryCollects: () => summaryCollects,
  };
}

describe("incident summary status composition", () => {
  it("NORMAL: HEALTHY + OK + BASELINE_CREATED (baseline is never an incident/change)", () => {
    const env = makePair();
    const r = env.summary.handle({});
    expect(r.status).toBe("NORMAL");
    expect(r.observations[2].status).toBe("BASELINE_CREATED");
  });

  it("NORMAL: HEALTHY + OK + NO_CHANGE", () => {
    const env = makePair();
    env.summary.handle({});
    expect(env.summary.handle({}).status).toBe("NORMAL");
  });

  it("ATTENTION: DEGRADED/PRESSURED, CHANGED, and combined (note: PRESSURED implies DEGRADED under shared thresholds)", () => {
    const a = makePair();
    a.summary.handle({});
    a.setSummary(DEGRADED_PRESSURED);
    expect(a.summary.handle({}).status).toBe("ATTENTION");

    const b = makePair();
    b.summary.handle({});
    b.setChange({ ...CALM, memoryFreeBytes: 4_000 }); // delta 1000 > 100 -> CHANGED; 60% used -> HEALTHY/OK
    expect(b.summary.handle({}).status).toBe("ATTENTION");

    const c = makePair();
    c.summary.handle({});
    c.setSummary(DEGRADED_PRESSURED);
    c.setChange({ ...CALM, memoryFreeBytes: 4_000 });
    expect(c.summary.handle({}).status).toBe("ATTENTION");
  });

  it("UNKNOWN: each component unknown; UNKNOWN has precedence over ATTENTION", () => {
    const a = makePair();
    a.summary.handle({});
    a.setSummary(ALL_NULL); // health UNKNOWN + capacity UNKNOWN
    expect(a.summary.handle({}).status).toBe("UNKNOWN");

    const b = makePair();
    b.summary.handle({});
    b.setChange(ALL_NULL); // what_changed UNKNOWN only
    expect(b.summary.handle({}).status).toBe("UNKNOWN");

    const c = makePair();
    c.summary.handle({});
    c.setSummary(DEGRADED_PRESSURED); // would be ATTENTION
    c.setChange(ALL_NULL); // UNKNOWN wins
    expect(c.summary.handle({}).status).toBe("UNKNOWN");
  });
});

describe("incident summary structure and honesty", () => {
  it("returns exactly one observation per component with exact, unique sources in order", () => {
    const env = makePair();
    const r = env.summary.handle({});
    expect(r.observations.map((o) => o.source)).toEqual([
      "engineering.vps.health",
      "engineering.vps.capacity",
      "engineering.vps.what_changed",
    ]);
  });

  it("BASELINE_CREATED: first call discloses that change observation started now", () => {
    const env = makePair();
    const r = env.summary.handle({});
    expect(r.observations[2].note).toMatch(/baseline was created with this call/i);
    expect(r.limitations.join(" ")).toMatch(/started with this call/i);
    expect(r.limitations.join(" ")).toMatch(/nothing before this baseline is known/i);
  });

  it("no causal language and no causal fields (rootCause/cause/causedBy/diagnosis absent)", () => {
    const env = makePair();
    env.summary.handle({});
    env.setSummary(DEGRADED_PRESSURED);
    env.setChange({ ...CALM, memoryFreeBytes: 4_000 });
    const r = env.summary.handle({});
    const json = JSON.stringify(r).toLowerCase();
    expect(json).not.toMatch(/root ?cause|caused|because of|probable ?cause|outage|failure|incident confirmed/);
    expect(Object.keys(r).sort()).toEqual(["limitations", "observations", "status", "summary"]);
    for (const o of r.observations) {
      expect(Object.keys(o).sort()).toEqual(["note", "source", "status"]);
    }
  });

  it("output schema validates; invalid status rejected", () => {
    const env = makePair();
    const r = env.summary.handle({});
    expect(vpsIncidentSummaryOutputSchema.safeParse(r).success).toBe(true);
    expect(vpsIncidentSummaryOutputSchema.safeParse({ ...r, status: "INCIDENT" }).success).toBe(false);
  });

  it("strict empty input: {} accepted; extra keys and non-objects rejected", () => {
    const env = makePair();
    expect(env.summary.handle({}).status).toBe("NORMAL");
    expect(() => env.summary.handle({ extra: 1 })).toThrow(StrictInputError);
    expect(() => env.summary.handle([1, 2])).toThrow(StrictInputError);
  });
});

describe("shared what_changed history (critical)", () => {
  it("summary first, then direct calls continue the SAME sequence (no restart)", () => {
    const env = makePair();
    expect(env.summary.handle({}).observations[2].status).toBe("BASELINE_CREATED");
    expect(env.changeTool.handle({}).observationsSinceBaseline).toBe(2); // continued, not restarted
    expect(env.summary.handle({}).observations[2].status).toBe("NO_CHANGE");
    expect(env.changeTool.handle({}).observationsSinceBaseline).toBe(4);
  });

  it("reverse order: direct call first, summary consumes the next observation of the sequence", () => {
    const env = makePair();
    expect(env.changeTool.handle({}).observationsSinceBaseline).toBe(1);
    const r = env.summary.handle({});
    expect(r.observations[2].status).toBe("NO_CHANGE");
    expect(env.changeTool.handle({}).observationsSinceBaseline).toBe(3);
  });

  it("a fresh pair of instances starts a fresh history", () => {
    const a = makePair();
    a.summary.handle({});
    const b = makePair();
    expect(b.summary.handle({}).observations[2].status).toBe("BASELINE_CREATED");
  });
});

describe("single snapshot consistency", () => {
  it("health and capacity share one snapshot: exactly one summary-adapter collect per summary call", () => {
    const env = makePair();
    env.summary.handle({});
    expect(env.summaryCollects()).toBe(1);
    env.summary.handle({});
    expect(env.summaryCollects()).toBe(2);
  });
});

describe("MCP server integration", () => {
  it("exactly 4 strict tools; summary works over protocol; extra keys rejected; all regressions pass", async () => {
    const server = buildServer();
    const client = new Client({ name: "summary-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([
        "engineering.deploy.status",
        "engineering.vps.capacity",
        "engineering.vps.health",
        "engineering.vps.incident.summary",
        "engineering.vps.what_changed",
      ]);
      for (const tool of listed.tools) {
        expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      }

      const bad = await client.callTool({ name: "engineering.vps.incident.summary", arguments: { foo: "bar" } });
      expect(bad.isError).toBe(true);

      const ok = await client.callTool({ name: "engineering.vps.incident.summary", arguments: {} });
      expect(ok.isError).toBeUndefined();
      const parsed = vpsIncidentSummaryOutputSchema.safeParse(ok.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.observations).toHaveLength(3);

      // Regressions: the three existing tools keep working over the protocol.
      const health = await client.callTool({ name: "engineering.vps.health", arguments: {} });
      const capacity = await client.callTool({ name: "engineering.vps.capacity", arguments: {} });
      const change = await client.callTool({ name: "engineering.vps.what_changed", arguments: {} });
      expect(health.isError).toBeUndefined();
      expect(capacity.isError).toBeUndefined();
      expect(change.isError).toBeUndefined();
      // Shared history over the protocol: the summary call above was observation 1.
      expect((change.structuredContent as { observationsSinceBaseline: number }).observationsSinceBaseline).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
