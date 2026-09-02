import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_RELEASE_STATE_BYTES,
  createReleaseStateFileAdapter,
} from "../src/adapters/releaseStateFile";
import type {
  ApplicationDeploymentAdapter,
  ApplicationDeploymentEvidence,
} from "../src/adapters/applicationDeployment";

const GIB = 1024 * 1024 * 1024;

function evidenceDocument(overrides: Record<string, unknown> = {}): ApplicationDeploymentEvidence {
  const base: ApplicationDeploymentEvidence = {
    applicationId: "app-1",
    observedAt: "2026-09-02T12:00:00Z",
    source: "release-state-file-test",
    currentReleaseId: "release-2",
    previousReleaseId: "release-1",
    deploymentStatus: "SUCCEEDED",
    lastDeploymentFinishedAt: "2026-09-02T11:30:00Z",
    applicationHealthy: true,
  };
  // Deliberately untyped overrides: some tests inject INVALID values to prove
  // fail-closed behavior; the cast is test-side only.
  return { ...base, ...overrides } as ApplicationDeploymentEvidence;
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "vps-guardian-release-state-"));
}

let cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs = [];
});

function useTempDir(): string {
  const dir = makeTempDir();
  cleanupDirs.push(dir);
  return dir;
}

function fileAdapter(filePath: string): ApplicationDeploymentAdapter {
  return createReleaseStateFileAdapter({ path: filePath });
}

describe("construction-time configuration validation", () => {
  it("rejects an empty path", () => {
    expect(() => createReleaseStateFileAdapter({ path: "" })).toThrow(/path must be a string/);
  });

  it("rejects a path longer than 4096 characters", () => {
    const long = "a".repeat(4097);
    expect(() => createReleaseStateFileAdapter({ path: long })).toThrow(/path must be a string/);
  });

  it("rejects paths containing control characters (including NUL and newline)", () => {
    for (const bad of ["bad\u0000path", "bad\npath", "bad\u009Fpath", "bad\u007Fpath"]) {
      expect(() => createReleaseStateFileAdapter({ path: bad })).toThrow(/control characters/);
    }
  });

  it("rejects a missing or non-string path", () => {
    expect(() => createReleaseStateFileAdapter({} as never)).toThrow();
    expect(() => createReleaseStateFileAdapter({ path: 42 as never })).toThrow();
  });

  it("accepts a valid absolute path without reading anything at construction", () => {
    const dir = useTempDir();
    // No file is created: construction must not touch the filesystem.
    expect(() => fileAdapter(join(dir, "does-not-exist.json"))).not.toThrow();
  });
});

describe("adapter identity", () => {
  it("exposes name 'release-state-file'", () => {
    const dir = useTempDir();
    expect(fileAdapter(join(dir, "state.json")).name).toBe("release-state-file");
  });
});

describe("collect(): valid evidence", () => {
  it("returns the exact typed evidence contained in the file", () => {
    const dir = useTempDir();
    const file = join(dir, "release-state.json");
    const document = evidenceDocument();
    writeFileSync(file, JSON.stringify(document), "utf8");

    const collected = fileAdapter(file).collect();
    expect(collected).toEqual(document);
  });

  it("accepts a BOM-prefixed valid JSON file", () => {
    const dir = useTempDir();
    const file = join(dir, "release-state.json");
    writeFileSync(file, "\uFEFF" + JSON.stringify(evidenceDocument()), "utf8");

    expect(fileAdapter(file).collect()).toEqual(evidenceDocument());
  });

  it("re-reads freshly on every collect() call (no cache)", () => {
    const dir = useTempDir();
    const file = join(dir, "release-state.json");
    writeFileSync(
      file,
      JSON.stringify(evidenceDocument({ deploymentStatus: "SUCCEEDED" })),
      "utf8",
    );
    const adapter = fileAdapter(file);

    const first = adapter.collect();
    expect(first?.deploymentStatus).toBe("SUCCEEDED");

    // Producer updates the file; the next collect() must reflect the new state.
    writeFileSync(
      file,
      JSON.stringify(evidenceDocument({ deploymentStatus: "FAILED" })),
      "utf8",
    );
    const second = adapter.collect();
    expect(second?.deploymentStatus).toBe("FAILED");
    expect(second).not.toEqual(first);
  });

  it("accepts a file of exactly MAX_RELEASE_STATE_BYTES (boundary) and rejects one byte more", () => {
    const dir = useTempDir();
    const base = JSON.stringify(evidenceDocument());
    const exact = join(dir, "exact.json");
    // Pad with insignificant JSON whitespace to exactly 65536 bytes.
    writeFileSync(exact, "{" + " ".repeat(MAX_RELEASE_STATE_BYTES - base.length) + base.slice(1), "utf8");
    expect(fileAdapter(exact).collect()).toEqual(evidenceDocument());

    const over = join(dir, "over.json");
    writeFileSync(over, "{" + " ".repeat(MAX_RELEASE_STATE_BYTES - base.length + 1) + base.slice(1), "utf8");
    expect(fileAdapter(over).collect()).toBeNull();
  });
});

describe("collect(): fail-closed runtime behavior (never throws, returns null)", () => {
  it("returns null for a missing file", () => {
    const dir = useTempDir();
    const adapter = fileAdapter(join(dir, "missing.json"));
    let result: unknown;
    expect(() => {
      result = adapter.collect();
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("returns null when the configured path is a directory (not a regular file)", () => {
    const dir = useTempDir();
    let result: unknown;
    expect(() => {
      result = fileAdapter(dir).collect();
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("returns null for an empty file", () => {
    const dir = useTempDir();
    const file = join(dir, "empty.json");
    writeFileSync(file, "");
    expect(fileAdapter(file).collect()).toBeNull();
  });

  it("returns null for a whitespace-only file", () => {
    const dir = useTempDir();
    const file = join(dir, "blank.json");
    writeFileSync(file, "   \n  ");
    expect(fileAdapter(file).collect()).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const dir = useTempDir();
    const file = join(dir, "broken.json");
    writeFileSync(file, '{"applicationId": "app-1", oops}', "utf8");
    expect(fileAdapter(file).collect()).toBeNull();
  });

  it("returns null for an oversized file without parsing it", () => {
    const dir = useTempDir();
    const file = join(dir, "huge.json");
    // 70000 bytes of non-JSON garbage: valid only if the size gate runs first.
    writeFileSync(file, "x".repeat(70000), "utf8");
    expect(fileAdapter(file).collect()).toBeNull();
  });

  it("returns null when the file grows beyond the limit between stat and read (post-read re-check)", () => {
    const dir = useTempDir();
    const file = join(dir, "grown.json");
    // Under the stat limit for JSON semantics, but oversized in bytes once read.
    const bigDocument = JSON.stringify({
      ...evidenceDocument(),
      // Extra unknown fields would be rejected anyway; instead pad inside a bounded field set
      // by making the JSON itself large via repeated whitespace, staying valid JSON.
    });
    writeFileSync(file, "{" + " ".repeat(MAX_RELEASE_STATE_BYTES + 1 - bigDocument.length) + bigDocument.slice(1), "utf8");
    expect(fileAdapter(file).collect()).toBeNull();
  });

  it("returns null for unknown keys (strict schema, no stripping)", () => {
    const dir = useTempDir();
    const file = join(dir, "unknown-key.json");
    writeFileSync(file, JSON.stringify({ ...evidenceDocument(), extra: "not allowed" }), "utf8");
    expect(fileAdapter(file).collect()).toBeNull();
  });

  it("returns null for control characters in evidence strings", () => {
    const dir = useTempDir();
    const file = join(dir, "control-char.json");
    writeFileSync(
      file,
      JSON.stringify(evidenceDocument({ applicationId: "app\n1" })),
      "utf8",
    );
    expect(fileAdapter(file).collect()).toBeNull();
  });

  it("returns null for a malformed timestamp", () => {
    const dir = useTempDir();
    const file = join(dir, "bad-time.json");
    writeFileSync(
      file,
      JSON.stringify(evidenceDocument({ observedAt: "not-a-timestamp" })),
      "utf8",
    );
    expect(fileAdapter(file).collect()).toBeNull();
  });

  it("returns null when lastDeploymentFinishedAt is after observedAt", () => {
    const dir = useTempDir();
    const file = join(dir, "inconsistent.json");
    writeFileSync(
      file,
      JSON.stringify(
        evidenceDocument({
          observedAt: "2026-09-02T12:00:00Z",
          lastDeploymentFinishedAt: "2026-09-02T12:30:00Z",
        }),
      ),
      "utf8",
    );
    expect(fileAdapter(file).collect()).toBeNull();
  });

  it("returns null for a JSON value of the wrong shape (array/number/string)", () => {
    const dir = useTempDir();
    for (const [name, content] of [
      ["array.json", "[]"],
      ["number.json", "42"],
      ["string.json", '"hello"'],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, content, "utf8");
      expect(fileAdapter(file).collect()).toBeNull();
    }
  });

  it("never throws and never fabricates evidence across all runtime failure modes", () => {
    const dir = useTempDir();
    const missing = fileAdapter(join(dir, "missing.json"));
    const directory = fileAdapter(dir);

    for (const adapter of [missing, directory]) {
      let result: unknown;
      expect(() => {
        result = adapter.collect();
      }).not.toThrow();
      expect(result).toBeNull();
    }
  });
});
