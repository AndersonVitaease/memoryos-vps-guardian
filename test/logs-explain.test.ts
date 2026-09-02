import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer, createLogEvidenceAdapterFromEnvironment, LOG_EVIDENCE_FILE_ENV_VAR } from "../src/server";
import { MAX_LOG_EVIDENCE_ENTRIES, tryParseLogEvidence } from "../src/adapters/logEvidence";
import type { LogEvidence, LogEvidenceAdapter, LogEvidenceEntry } from "../src/adapters/logEvidence";
import { createLogEvidenceFileAdapter } from "../src/adapters/logEvidenceFile";
import { assessLogsExplain, handleLogsExplain, logsExplainOutputSchema } from "../src/tools/logsExplain";
import type { LogsExplainToolResult } from "../src/tools/logsExplain";

const EXACT_OUTPUT_KEYS = [
  "status",
  "summary",
  "source",
  "observedAt",
  "evidenceAgeSeconds",
  "explanations",
  "limitations",
].sort();

const EXACT_EXPLANATION_KEYS = ["category", "severity", "meaning", "suggestedCheck"].sort();

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

function entry(overrides: Partial<LogEvidenceEntry> = {}): LogEvidenceEntry {
  return {
    timestamp: "2026-09-02T11:59:00Z",
    severity: "ERROR",
    code: null,
    message: null,
    ...overrides,
  };
}

function logEvidence(overrides: Partial<LogEvidence> = {}): LogEvidence {
  return {
    observedAt: "2026-09-02T12:00:00Z",
    source: "log-evidence-file",
    entries: [],
    ...overrides,
  };
}

const KNOWN_EVIDENCE: LogEvidence = logEvidence({
  entries: [entry({ code: "ECONNREFUSED", severity: "ERROR" })],
});

interface Counting<T> {
  adapter: T;
  calls: () => number;
}

function countingLogs(evidence: LogEvidence | null): Counting<LogEvidenceAdapter> {
  let calls = 0;
  return {
    adapter: {
      name: "stub-log-evidence",
      collect() {
        calls += 1;
        return evidence;
      },
    },
    calls: () => calls,
  };
}

function countingClock(returnValue = Date.parse("2026-09-02T12:00:10Z")): { nowMs: () => number; calls: () => number } {
  let calls = 0;
  return {
    nowMs: () => {
      calls += 1;
      return returnValue;
    },
    calls: () => calls,
  };
}

function handle(
  logs: LogEvidenceAdapter | null = countingLogs(KNOWN_EVIDENCE).adapter,
  input: unknown = {},
  nowMs: () => number = () => Date.parse("2026-09-02T12:00:10Z"),
): LogsExplainToolResult {
  return handleLogsExplain(input, logs, nowMs);
}

async function withServer(logs?: LogEvidenceAdapter) {
  const server = buildServer({ logsEvidenceAdapter: logs ?? null });
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

describe("logs_explain > strict input", () => {
  it("accepts exactly empty input ({} / undefined / null)", () => {
    expect(handle(undefined, {}).status).toBe("EXPLAINED");
    expect(handle(undefined, undefined).status).toBe("EXPLAINED");
    expect(handle(undefined, null).status).toBe("EXPLAINED");
  });

  it("rejects every agent-steerable parameter", () => {
    for (const bad of [
      { path: "C:/x" },
      { file: "x.log" },
      { directory: "C:/logs" },
      { container: "web-1" },
      { service: "api" },
      { application: "app" },
      { host: "h" },
      { url: "http://x" },
      { query: "q" },
      { filter: "f" },
      { pattern: "p" },
      { grep: "g" },
      { since: "2026-01-01" },
      { until: "2026-01-02" },
      { limit: 10 },
      { command: "docker logs x" },
      { journal: "nginx" },
      { unit: "nginx.service" },
      { credentials: "c" },
      { token: "t" },
      { source: "s" },
      { extra: 1 },
    ]) {
      expect(() => handle(undefined, bad)).toThrow(/input must be exactly \{\}/);
    }
  });
});

describe("logs_explain > evidence contract (tryParseLogEvidence)", () => {
  it("accepts a valid minimal document with null message and code-only entries", () => {
    const valid = logEvidence({
      entries: [
        entry({ code: "ECONNREFUSED" }),
        entry({ code: null, message: "request timeout after 30s", severity: "WARNING" }),
      ],
    });
    expect(tryParseLogEvidence(valid)).toEqual(valid);
  });

  it("rejects unknown top-level and entry keys (strict schema)", () => {
    expect(tryParseLogEvidence({ ...logEvidence(), extra: 1 })).toBeNull();
    expect(
      tryParseLogEvidence(logEvidence({ entries: [{ ...entry(), stack: "at ..." }] as unknown as LogEvidenceEntry[] })),
    ).toBeNull();
  });

  it("rejects entries beyond the bounded count (101 > 100, 100 accepted)", () => {
    expect(tryParseLogEvidence(logEvidence({ entries: Array.from({ length: MAX_LOG_EVIDENCE_ENTRIES }, () => entry()) }))).not.toBeNull();
    expect(tryParseLogEvidence(logEvidence({ entries: Array.from({ length: MAX_LOG_EVIDENCE_ENTRIES + 1 }, () => entry()) }))).toBeNull();
  });

  it("rejects over-long strings (message > 200, code > 64, source > 100)", () => {
    expect(tryParseLogEvidence(logEvidence({ entries: [entry({ message: "x".repeat(201) })] }))).toBeNull();
    expect(tryParseLogEvidence(logEvidence({ entries: [entry({ code: "x".repeat(65) })] }))).toBeNull();
    expect(tryParseLogEvidence(logEvidence({ source: "x".repeat(101) }))).toBeNull();
  });

  it("rejects control characters and blank codes", () => {
    expect(tryParseLogEvidence(logEvidence({ entries: [entry({ message: "bad\u0007bell" })] }))).toBeNull();
    expect(tryParseLogEvidence(logEvidence({ entries: [entry({ code: "E\u0000X" })] }))).toBeNull();
    expect(tryParseLogEvidence(logEvidence({ source: "src\u001F" }))).toBeNull();
    expect(tryParseLogEvidence(logEvidence({ entries: [entry({ code: "   " })] }))).toBeNull();
  });

  it("rejects malformed timestamps and unknown severities", () => {
    expect(tryParseLogEvidence(logEvidence({ observedAt: "2026-09-02 12:00:00" }))).toBeNull();
    expect(tryParseLogEvidence(logEvidence({ entries: [entry({ timestamp: "yesterday" })] }))).toBeNull();
    expect(
      tryParseLogEvidence(
        logEvidence({ entries: [entry({ severity: "FATAL" } as unknown as Partial<LogEvidenceEntry>)] }),
      ),
    ).toBeNull();
  });
});

describe("logs_explain > pure classifier (assessLogsExplain)", () => {
  it("prefers producer-supplied structured codes over message rules", () => {
    const assessed = assessLogsExplain(
      logEvidence({ entries: [entry({ code: "ECONNREFUSED", message: "health check failed" })] }),
    );
    expect(assessed.status).toBe("EXPLAINED");
    expect(assessed.explanations).toHaveLength(1);
    expect(assessed.explanations[0].category).toBe("CONNECTION_REFUSED");
  });

  it("matches codes case-insensitively", () => {
    const assessed = assessLogsExplain(logEvidence({ entries: [entry({ code: "econnrefused" })] }));
    expect(assessed.explanations[0].category).toBe("CONNECTION_REFUSED");
  });

  it("falls back to the small fixed message rule set only when no code matches", () => {
    const cases: Array<[string, string]> = [
      ["Out of memory: killed process 7", "OUT_OF_MEMORY"],
      ["request timeout after 30s", "TIMEOUT"],
      ["permission denied for user deploy", "PERMISSION_FAILURE"],
      ["getaddrinfo ENOTFOUND example.invalid", "DNS_FAILURE"],
      ["bind: address already in use", "PORT_BIND_FAILURE"],
      ["health check failed", "HEALTHCHECK_FAILURE"],
      ["process exited with signal SIGKILL", "PROCESS_EXIT"],
    ];
    for (const [message, expected] of cases) {
      const assessed = assessLogsExplain(logEvidence({ entries: [entry({ code: null, message })] }));
      expect(assessed.explanations, message).toHaveLength(1);
      expect(assessed.explanations[0].category, message).toBe(expected);
    }
  });

  it("reports UNKNOWN (never a guess) for unclassifiable entries and UNKNOWN overall when all are unclassifiable", () => {
    const assessed = assessLogsExplain(
      logEvidence({ entries: [entry({ code: null, message: "totally unusual gibberish" }), entry()] }),
    );
    expect(assessed.status).toBe("UNKNOWN");
    expect(assessed.explanations).toHaveLength(1);
    expect(assessed.explanations[0].category).toBe("UNKNOWN");
    expect(assessed.summary).toMatch(/2 log signal\(s\) could not be mapped/);
  });

  it("reports UNKNOWN for a valid document with zero entries", () => {
    const assessed = assessLogsExplain(logEvidence({ entries: [] }));
    expect(assessed.status).toBe("UNKNOWN");
    expect(assessed.explanations).toEqual([]);
    expect(assessed.summary).toMatch(/no log signal entries/);
  });

  it("groups multiple signals in first-occurrence order with UNKNOWN last", () => {
    const assessed = assessLogsExplain(
      logEvidence({
        entries: [
          entry({ code: "EADDRINUSE" }),
          entry({ code: "OOM_KILLED" }),
          entry({ code: null, message: "connection refused" }),
          entry({ code: null, message: "gibberish" }),
        ],
      }),
    );
    expect(assessed.status).toBe("EXPLAINED");
    expect(assessed.explanations.map((explanation) => explanation.category)).toEqual([
      "PORT_BIND_FAILURE",
      "OUT_OF_MEMORY",
      "CONNECTION_REFUSED",
      "UNKNOWN",
    ]);
    expect(assessed.summary).toMatch(/3 log signal\(s\) were mapped to 3 deterministic categories/);
    expect(assessed.summary).toMatch(/1 additional signal\(s\) are reported as UNKNOWN/);
  });

  it("preserves severity per category as the highest observed severity", () => {
    const assessed = assessLogsExplain(
      logEvidence({
        entries: [
          entry({ code: "OOM", severity: "WARNING" }),
          entry({ code: "OOM", severity: "CRITICAL" }),
          entry({ code: "ETIMEDOUT", severity: "INFO" }),
        ],
      }),
    );
    const byCategory = Object.fromEntries(
      assessed.explanations.map((explanation) => [explanation.category, explanation.severity]),
    );
    expect(byCategory.OUT_OF_MEMORY).toBe("CRITICAL");
    expect(byCategory.TIMEOUT).toBe("INFO");
  });

  it("is deterministic: identical evidence produces identical results", () => {
    const evidence = logEvidence({
      entries: [entry({ code: "EACCES" }), entry({ code: null, message: "timed out" })],
    });
    expect(assessLogsExplain(evidence)).toEqual(assessLogsExplain(evidence));
  });
});

describe("logs_explain > handler (handleLogsExplain)", () => {
  it("UNAVAILABLE when no adapter is configured (null and undefined), clock never called", () => {
    const clock = countingClock();
    const nullResult = handleLogsExplain({}, null, clock.nowMs);
    const undefinedResult = handleLogsExplain({}, undefined, clock.nowMs);
    expect(nullResult.status).toBe("UNAVAILABLE");
    expect(undefinedResult.status).toBe("UNAVAILABLE");
    expect(nullResult.explanations).toEqual([]);
    expect(nullResult.source).toBeNull();
    expect(nullResult.observedAt).toBeNull();
    expect(nullResult.evidenceAgeSeconds).toBeNull();
    expect(clock.calls()).toBe(0);
  });

  it("UNAVAILABLE (fail closed) when the configured source returns no valid evidence, clock never called", () => {
    const clock = countingClock();
    const logs = countingLogs(null);
    const result = handleLogsExplain({}, logs.adapter, clock.nowMs);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.explanations).toEqual([]);
    expect(logs.calls()).toBe(1);
    expect(clock.calls()).toBe(0);
  });

  it("EXPLAINED with provenance from evidence and exactly one clock call", () => {
    const clock = countingClock();
    const logs = countingLogs(KNOWN_EVIDENCE);
    const result = handleLogsExplain({}, logs.adapter, clock.nowMs);
    expect(result.status).toBe("EXPLAINED");
    expect(result.source).toBe("log-evidence-file");
    expect(result.observedAt).toBe("2026-09-02T12:00:00Z");
    expect(result.evidenceAgeSeconds).toBe(10);
    expect(logs.calls()).toBe(1);
    expect(clock.calls()).toBe(1);
  });

  it("preserves negative evidence age as factual (never verdict-changing)", () => {
    const clock = countingClock(Date.parse("2026-09-02T11:59:50Z"));
    const result = handleLogsExplain({}, countingLogs(KNOWN_EVIDENCE).adapter, clock.nowMs);
    expect(result.evidenceAgeSeconds).toBe(-10);
    expect(result.status).toBe("EXPLAINED");
  });

  it("has the exact small output shape: 7 keys, explanations of 4 keys, 5 limitations", () => {
    const result = handle();
    expect(Object.keys(result).sort()).toEqual(EXACT_OUTPUT_KEYS);
    for (const explanation of result.explanations) {
      expect(Object.keys(explanation).sort()).toEqual(EXACT_EXPLANATION_KEYS);
    }
    expect(result.limitations).toHaveLength(5);
    expect(Object.keys(result)).not.toContain("entries");
  });

  it("never returns raw evidence messages or credential-like content", () => {
    const result = handleLogsExplain(
      {},
      countingLogs(
        logEvidence({
          entries: [
            entry({ code: null, message: "Authorization: Bearer sk-abc123 password=hunter2 cookie=s3cret" }),
          ],
        }),
      ).adapter,
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain("sk-abc123");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("Bearer");
    expect(text).not.toMatch(/token|secret|password|credential|authorization|cookie/i);
  });

  it("suggestedCheck is advisory plain language: no executable shell commands", () => {
    const result = handle(
      countingLogs(
        logEvidence({
          entries: [
            entry({ code: "OOM" }),
            entry({ code: "EADDRINUSE" }),
            entry({ code: "ENOTFOUND" }),
            entry({ code: "EACCES" }),
            entry({ code: "CRASHED" }),
            entry({ code: "UNHEALTHY" }),
            entry({ code: "ETIMEDOUT" }),
            entry({ code: null, message: "connection refused" }),
          ],
        }),
      ).adapter,
    );
    const text = JSON.stringify(result.explanations);
    expect(text).not.toMatch(/\b(sudo|docker|journalctl|curl|ssh|systemctl|kill|restart|rm)\b/i);
    for (const explanation of result.explanations) {
      expect(explanation.suggestedCheck.startsWith("Verify") || explanation.suggestedCheck.startsWith("Review")).toBe(true);
      expect(explanation.suggestedCheck.endsWith(".")).toBe(true);
    }
  });

  it("output schema enforces the status, category and severity vocabularies", () => {
    expect(logsExplainOutputSchema.safeParse(handle()).success).toBe(true);

    const badStatus = logsExplainOutputSchema.safeParse({
      status: "MAYBE",
      summary: "s",
      source: null,
      observedAt: null,
      evidenceAgeSeconds: null,
      explanations: [],
      limitations: [],
    });
    expect(badStatus.success).toBe(false);

    const badCategory = logsExplainOutputSchema.safeParse({
      status: "EXPLAINED",
      summary: "s",
      source: null,
      observedAt: null,
      evidenceAgeSeconds: null,
      explanations: [{ category: "MAGIC", severity: "ERROR", meaning: "m", suggestedCheck: "c" }],
      limitations: [],
    });
    expect(badCategory.success).toBe(false);

    const badSeverity = logsExplainOutputSchema.safeParse({
      status: "EXPLAINED",
      summary: "s",
      source: null,
      observedAt: null,
      evidenceAgeSeconds: null,
      explanations: [{ category: "TIMEOUT", severity: "FATAL", meaning: "m", suggestedCheck: "c" }],
      limitations: [],
    });
    expect(badSeverity.success).toBe(false);
  });
});

describe("logs_explain > log-evidence file transport (operator-fixed path)", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "log-evidence-test-"));

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function tempFile(name: string, content: string): string {
    const filePath = join(tempRoot, name);
    writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  it("collects a valid document and tolerates exactly one UTF-8 BOM", () => {
    const adapter = createLogEvidenceFileAdapter({
      path: tempFile("valid.json", "\ufeff" + JSON.stringify(KNOWN_EVIDENCE)),
    });
    expect(adapter.name).toBe("log-evidence-file");
    expect(adapter.collect()).toEqual(KNOWN_EVIDENCE);
  });

  it("fails closed on a missing file, a directory, malformed JSON and an invalid schema", () => {
    expect(createLogEvidenceFileAdapter({ path: join(tempRoot, "missing.json") }).collect()).toBeNull();
    expect(createLogEvidenceFileAdapter({ path: tempRoot }).collect()).toBeNull();
    expect(createLogEvidenceFileAdapter({ path: tempFile("garbage.logjson", "not json{{") }).collect()).toBeNull();
    expect(
      createLogEvidenceFileAdapter({
        path: tempFile("extra.json", JSON.stringify({ ...KNOWN_EVIDENCE, entries: [{ ...entry(), stack: "at ..." }] })),
      }).collect(),
    ).toBeNull();
  });

  it("fails closed on an oversized file (> 65536 bytes) checked before and after read", () => {
    const oversized = createLogEvidenceFileAdapter({ path: tempFile("big.json", "x".repeat(70000)) });
    expect(oversized.collect()).toBeNull();
  });

  it("throws at construction on an invalid operator path (empty, control characters, over-long, wrong type)", () => {
    expect(() => createLogEvidenceFileAdapter({ path: "" })).toThrow(/1-4096 characters/);
    expect(() => createLogEvidenceFileAdapter({ path: "bad\u0000path" })).toThrow(/control characters/);
    expect(() => createLogEvidenceFileAdapter({ path: "x".repeat(4097) })).toThrow(/1-4096 characters/);
    expect(() => createLogEvidenceFileAdapter({ path: 42 as unknown as string })).toThrow(/1-4096 characters/);
  });
});

describe("logs_explain > server wiring", () => {
  it("maps the ONE operator env var to the adapter; unset or empty means no adapter", () => {
    expect(createLogEvidenceAdapterFromEnvironment(() => undefined)).toBeNull();
    expect(createLogEvidenceAdapterFromEnvironment(() => "")).toBeNull();
    const seen: string[] = [];
    const adapter = createLogEvidenceAdapterFromEnvironment((name) => {
      seen.push(name);
      return join(tempRootShared(), "never-read.json");
    });
    expect(adapter).not.toBeNull();
    expect(adapter?.name).toBe("log-evidence-file");
    expect(seen).toEqual([LOG_EVIDENCE_FILE_ENV_VAR]);
  });

  it("throws at startup on an invalid operator path value", () => {
    expect(() => createLogEvidenceAdapterFromEnvironment(() => "bad\u0000path")).toThrow(/control characters/);
  });

  it("catalog contains engineering.logs.explain and exactly 10 tools", async () => {
    const { client, close } = await withServer();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      expect(names).toContain("engineering.logs.explain");
      expect(tools.tools).toHaveLength(10);
    } finally {
      await close();
    }
  });

  it("rejects non-empty arguments at the protocol layer (agent can never select a path or source)", async () => {
    const { client, close } = await withServer();
    try {
      const call = await client.callTool({ name: "engineering.logs.explain", arguments: { path: "C:/logs/app.log" } });
      expect(call.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("zero-config server starts, keeps the tool registered and truthfully reports UNAVAILABLE", async () => {
    const { client, close } = await withServer();
    try {
      const call = await client.callTool({ name: "engineering.logs.explain", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text);
      expect(parsed.status).toBe("UNAVAILABLE");
      expect(parsed.explanations).toEqual([]);
      expect(parsed.source).toBeNull();
      expect(parsed.observedAt).toBeNull();
      expect(parsed.evidenceAgeSeconds).toBeNull();
      expect(parsed.limitations).toHaveLength(5);
    } finally {
      await close();
    }
  });

  it("injected evidence flows through the protocol as a deterministic explanation", async () => {
    const { client, close } = await withServer(countingLogs(KNOWN_EVIDENCE).adapter);
    try {
      const call = await client.callTool({ name: "engineering.logs.explain", arguments: {} });
      expect(call.isError).toBeUndefined();
      const parsed = JSON.parse((call.content as Array<{ text: string }>)[0].text);
      expect(parsed.status).toBe("EXPLAINED");
      expect(parsed.explanations).toHaveLength(1);
      expect(parsed.explanations[0].category).toBe("CONNECTION_REFUSED");
      expect(parsed.explanations[0].severity).toBe("ERROR");
      expect(parsed.source).toBe("log-evidence-file");
    } finally {
      await close();
    }
  });

  it("repeated MCP calls return identical structured output", async () => {
    const { client, close } = await withServer();
    try {
      const first = await client.callTool({ name: "engineering.logs.explain", arguments: {} });
      const second = await client.callTool({ name: "engineering.logs.explain", arguments: {} });
      const a = JSON.parse((first.content as Array<{ text: string }>)[0].text);
      const b = JSON.parse((second.content as Array<{ text: string }>)[0].text);
      expect(a).toEqual(b);
    } finally {
      await close();
    }
  });
});

function tempRootShared(): string {
  return tmpdir();
}
