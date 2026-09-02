import { describe, expect, it } from "vitest";
import {
  ApplicationDeploymentEvidenceError,
  applicationDeploymentEvidenceSchema,
  parseApplicationDeploymentEvidence,
  tryParseApplicationDeploymentEvidence,
} from "../src/adapters/applicationDeployment";
import type {
  ApplicationDeploymentAdapter,
  ApplicationDeploymentEvidence,
} from "../src/adapters/applicationDeployment";
import type { VpsHealthEvidence } from "../src/adapters/systemHealth";
import {
  assessApplicationHealth,
  assessDeployReady,
  assessDeployStatus,
} from "../src/tools/applicationDeployment";

const GIB = 1024 * 1024 * 1024;

function validEvidence(overrides: Record<string, unknown> = {}): ApplicationDeploymentEvidence {
  const base: ApplicationDeploymentEvidence = {
    applicationId: "app-1",
    observedAt: "2026-09-02T12:00:00Z",
    source: "unit-test",
    currentReleaseId: "release-2",
    previousReleaseId: "release-1",
    deploymentStatus: "SUCCEEDED",
    lastDeploymentFinishedAt: "2026-09-02T11:30:00Z",
    applicationHealthy: true,
  };
  // Deliberately untyped overrides: some tests inject INVALID values to prove
  // the strict validator rejects them; the cast is test-side only.
  return { ...base, ...overrides } as ApplicationDeploymentEvidence;
}

function hostEvidence(overrides: Partial<VpsHealthEvidence> = {}): VpsHealthEvidence {
  return {
    uptimeSeconds: 3_600_000,
    cpuCount: 4,
    loadAverage1m: 1.2,
    memoryTotalBytes: 16 * GIB,
    memoryFreeBytes: 8 * GIB,
    ...overrides,
  };
}

const HEALTHY_HOST = hostEvidence();

describe("applicationDeploymentEvidenceSchema (strict validation)", () => {
  it("accepts fully populated valid evidence unchanged", () => {
    const parsed = parseApplicationDeploymentEvidence(validEvidence());
    expect(parsed).toEqual(validEvidence());
    expect(parsed.deploymentStatus).toBe("SUCCEEDED");
    expect(parsed.applicationHealthy).toBe(true);
  });

  it("accepts minimal valid evidence where every observable field is null", () => {
    const parsed = parseApplicationDeploymentEvidence(
      validEvidence({
        currentReleaseId: null,
        previousReleaseId: null,
        deploymentStatus: null,
        lastDeploymentFinishedAt: null,
        applicationHealthy: null,
      }),
    );
    expect(parsed.currentReleaseId).toBeNull();
    expect(parsed.deploymentStatus).toBeNull();
    expect(parsed.applicationHealthy).toBeNull();
  });

  it("accepts millisecond-precision UTC timestamps", () => {
    const parsed = parseApplicationDeploymentEvidence(
      validEvidence({
        observedAt: "2026-09-02T12:00:00.123Z",
        lastDeploymentFinishedAt: "2026-09-02T11:59:59.999Z",
      }),
    );
    expect(parsed.observedAt).toBe("2026-09-02T12:00:00.123Z");
  });

  it("accepts lastDeploymentFinishedAt exactly equal to observedAt (not after)", () => {
    const parsed = parseApplicationDeploymentEvidence(
      validEvidence({ observedAt: "2026-09-02T12:00:00Z", lastDeploymentFinishedAt: "2026-09-02T12:00:00Z" }),
    );
    expect(parsed.lastDeploymentFinishedAt).toBe("2026-09-02T12:00:00Z");
  });

  it("rejects unknown top-level keys (strict object, no stripping)", () => {
    const bad = { ...validEvidence(), extra: "not allowed" };
    expect(() => parseApplicationDeploymentEvidence(bad)).toThrow(ApplicationDeploymentEvidenceError);
    expect(tryParseApplicationDeploymentEvidence(bad)).toBeNull();
    expect(applicationDeploymentEvidenceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects empty, over-length and non-string identifiers (bounded strings)", () => {
    expect(() => parseApplicationDeploymentEvidence(validEvidence({ applicationId: "" }))).toThrow();
    expect(() =>
      parseApplicationDeploymentEvidence(validEvidence({ applicationId: "a".repeat(201) })),
    ).toThrow();
    expect(() => parseApplicationDeploymentEvidence(validEvidence({ source: "s".repeat(101) }))).toThrow();
    expect(() => parseApplicationDeploymentEvidence(validEvidence({ applicationId: 42 }))).toThrow();
  });

  it("rejects control characters in evidence strings (no log/summary injection)", () => {
    for (const bad of ["app\nid", "app\u0000", "app\tid", "app\u001Fid", "app\u009Fid", "app\u007Fid"]) {
      expect(() => parseApplicationDeploymentEvidence(validEvidence({ applicationId: bad }))).toThrow();
      expect(tryParseApplicationDeploymentEvidence(validEvidence({ applicationId: bad }))).toBeNull();
    }
    expect(() => parseApplicationDeploymentEvidence(validEvidence({ source: "x\ny" }))).toThrow();
  });

  it("rejects malformed timestamps (structure and offset forms)", () => {
    for (const bad of [
      "not-a-timestamp",
      "2026-09-02 12:00:00Z",
      "2026-09-02T12:00:00",
      "2026-09-02T12:00:00+02:00",
      "2026-9-2T12:00:00Z",
    ]) {
      expect(() => parseApplicationDeploymentEvidence(validEvidence({ observedAt: bad }))).toThrow();
      expect(tryParseApplicationDeploymentEvidence(validEvidence({ observedAt: bad }))).toBeNull();
    }
  });

  it("rejects structurally valid but semantically impossible timestamps", () => {
    for (const bad of ["2026-13-01T00:00:00Z", "2026-01-32T00:00:00Z", "2026-01-01T25:00:00Z"]) {
      expect(() => parseApplicationDeploymentEvidence(validEvidence({ observedAt: bad }))).toThrow();
    }
  });

  it("rejects lastDeploymentFinishedAt after observedAt (inconsistent evidence is never repaired)", () => {
    const bad = validEvidence({
      observedAt: "2026-09-02T12:00:00Z",
      lastDeploymentFinishedAt: "2026-09-02T12:30:00Z",
    });
    expect(() => parseApplicationDeploymentEvidence(bad)).toThrow(/must not be after observedAt/);
    expect(tryParseApplicationDeploymentEvidence(bad)).toBeNull();
  });

  it("rejects invalid deploymentStatus values (closed enum, null allowed)", () => {
    expect(() =>
      parseApplicationDeploymentEvidence(validEvidence({ deploymentStatus: "RUNNING" })),
    ).toThrow();
    expect(() => parseApplicationDeploymentEvidence(validEvidence({ applicationHealthy: "yes" }))).toThrow();
  });
});

describe("assessApplicationHealth (exact mapping)", () => {
  it("maps evidence null to UNAVAILABLE with no fabricated values", () => {
    const result = assessApplicationHealth(null);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.applicationId).toBeNull();
    expect(result.source).toBeNull();
    expect(result.observedAt).toBeNull();
  });

  it("maps applicationHealthy true to HEALTHY and passes identity/provenance through", () => {
    const result = assessApplicationHealth(validEvidence());
    expect(result.status).toBe("HEALTHY");
    expect(result.applicationId).toBe("app-1");
    expect(result.source).toBe("unit-test");
    expect(result.observedAt).toBe("2026-09-02T12:00:00Z");
  });

  it("maps applicationHealthy false to DEGRADED", () => {
    const result = assessApplicationHealth(validEvidence({ applicationHealthy: false }));
    expect(result.status).toBe("DEGRADED");
  });

  it("maps applicationHealthy null to UNKNOWN (no health is inferred)", () => {
    const result = assessApplicationHealth(validEvidence({ applicationHealthy: null }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.summary).toContain("not reported");
  });
});

describe("assessDeployStatus (exact mapping)", () => {
  it("maps evidence null to UNAVAILABLE", () => {
    const result = assessDeployStatus(null);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.currentReleaseId).toBeNull();
    expect(result.lastDeploymentFinishedAt).toBeNull();
  });

  it("maps SUCCEEDED to OK", () => {
    const result = assessDeployStatus(validEvidence({ deploymentStatus: "SUCCEEDED" }));
    expect(result.status).toBe("OK");
    expect(result.summary).toContain("SUCCEEDED");
  });

  it("maps IN_PROGRESS to IN_FLIGHT", () => {
    const result = assessDeployStatus(validEvidence({ deploymentStatus: "IN_PROGRESS" }));
    expect(result.status).toBe("IN_FLIGHT");
  });

  it("maps QUEUED to PENDING", () => {
    const result = assessDeployStatus(validEvidence({ deploymentStatus: "QUEUED" }));
    expect(result.status).toBe("PENDING");
  });

  it("maps FAILED to FAILED", () => {
    const result = assessDeployStatus(validEvidence({ deploymentStatus: "FAILED" }));
    expect(result.status).toBe("FAILED");
  });

  it("maps null deploymentStatus to UNKNOWN (no deployment state is inferred)", () => {
    const result = assessDeployStatus(validEvidence({ deploymentStatus: null }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.summary).toContain("not reported");
  });

  it("passes release and timing facts through unchanged", () => {
    const result = assessDeployStatus(validEvidence());
    expect(result.applicationId).toBe("app-1");
    expect(result.currentReleaseId).toBe("release-2");
    expect(result.previousReleaseId).toBe("release-1");
    expect(result.lastDeploymentFinishedAt).toBe("2026-09-02T11:30:00Z");
  });
});

describe("assessDeployReady (advisory composition)", () => {
  it("returns READY for SUCCEEDED + healthy application + healthy VPS, with an advisory-only summary", () => {
    const result = assessDeployReady(validEvidence(), HEALTHY_HOST);
    expect(result.status).toBe("READY");
    expect(result.reasons).toEqual([]);
    expect(result.summary).toContain("Advisory only");
    expect(result.summary).toContain("grants no deployment authority");
  });

  it("treats a FAILED last deployment with a currently healthy system as READY (documented literal semantics)", () => {
    const result = assessDeployReady(
      validEvidence({ deploymentStatus: "FAILED", applicationHealthy: true }),
      HEALTHY_HOST,
    );
    expect(result.status).toBe("READY");
  });

  it("blocks READY when the deployment is IN_PROGRESS", () => {
    const result = assessDeployReady(validEvidence({ deploymentStatus: "IN_PROGRESS" }), HEALTHY_HOST);
    expect(result.status).toBe("NOT_READY");
    expect(result.reasons.join(" ")).toContain("IN_PROGRESS");
  });

  it("blocks READY when the deployment is QUEUED", () => {
    const result = assessDeployReady(validEvidence({ deploymentStatus: "QUEUED" }), HEALTHY_HOST);
    expect(result.status).toBe("NOT_READY");
    expect(result.reasons.join(" ")).toContain("QUEUED");
  });

  it("blocks READY when the application is reported as not healthy (DEGRADED/PRESSURED-style block)", () => {
    const result = assessDeployReady(validEvidence({ applicationHealthy: false }), HEALTHY_HOST);
    expect(result.status).toBe("NOT_READY");
    expect(result.components.applicationHealth).toBe("DEGRADED");
  });

  it("blocks READY when the existing VPS health assessment is DEGRADED", () => {
    const degradedHost = hostEvidence({ memoryFreeBytes: Math.floor(16 * GIB * 0.05) }); // ~94.9% used
    const result = assessDeployReady(validEvidence(), degradedHost);
    expect(result.components.vpsHealth).toBe("DEGRADED");
    expect(result.status).toBe("NOT_READY");
    expect(result.reasons.join(" ")).toContain("VPS health");
  });

  it("blocks READY when the existing VPS capacity assessment is PRESSURED", () => {
    const pressuredHost = hostEvidence({ cpuCount: 4, loadAverage1m: 9 }); // 2.25 per CPU > 2
    const result = assessDeployReady(validEvidence(), pressuredHost);
    expect(result.components.vpsCapacity).toBe("PRESSURED");
    expect(result.status).toBe("NOT_READY");
  });

  it("is UNKNOWN-first: a required UNKNOWN component beats DEGRADED/PRESSURED blocks (never NOT_READY on missing evidence)", () => {
    const unknownDeployment = validEvidence({ deploymentStatus: null, applicationHealthy: false });
    const result = assessDeployReady(unknownDeployment, HEALTHY_HOST);
    expect(result.status).toBe("UNKNOWN");

    const unknownVps = assessDeployReady(validEvidence(), hostEvidence({ uptimeSeconds: null, cpuCount: null }));
    expect(unknownVps.status).toBe("UNKNOWN");
    expect(unknownVps.components.vpsHealth).toBe("UNKNOWN");
    expect(unknownVps.components.vpsCapacity).toBe("UNKNOWN");
  });

  it("returns UNAVAILABLE when the application/deployment evidence source returns null", () => {
    const result = assessDeployReady(null, HEALTHY_HOST);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.components.deployment).toBe("UNAVAILABLE");
    expect(result.components.applicationHealth).toBe("UNAVAILABLE");
  });

  it("returns UNAVAILABLE when the VPS evidence is null, without inventing VPS component states", () => {
    const result = assessDeployReady(validEvidence(), null);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.components.vpsHealth).toBe("UNAVAILABLE");
    expect(result.components.vpsCapacity).toBe("UNAVAILABLE");
    expect(result.components.applicationHealth).toBe("HEALTHY");
  });

  it("carries the application identity through", () => {
    const result = assessDeployReady(validEvidence(), HEALTHY_HOST);
    expect(result.applicationId).toBe("app-1");
  });
});

describe("ApplicationDeploymentAdapter (collect null semantics, pure seam)", () => {
  function staticAdapter(evidence: ApplicationDeploymentEvidence | null): ApplicationDeploymentAdapter & { calls: number } {
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

  it("supplies typed evidence through the same injectable pattern as SystemHealthAdapter", () => {
    const adapter = staticAdapter(validEvidence());
    const result = assessDeployStatus(adapter.collect());
    expect(adapter.calls).toBe(1);
    expect(result.status).toBe("OK");
  });

  it("maps a null collect() result to deterministic UNAVAILABLE, never to a guessed status", () => {
    const adapter = staticAdapter(null);
    expect(assessDeployStatus(adapter.collect()).status).toBe("UNAVAILABLE");
    expect(assessApplicationHealth(adapter.collect()).status).toBe("UNAVAILABLE");
    expect(assessDeployReady(adapter.collect(), HEALTHY_HOST).status).toBe("UNAVAILABLE");
  });

  it("is deterministic: identical evidence yields identical classifications with no state", () => {
    const first = assessDeployStatus(validEvidence());
    const second = assessDeployStatus(validEvidence());
    expect(first).toEqual(second);
  });
});
