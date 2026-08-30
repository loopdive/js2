// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5215 — a complete-looking JSONL is publishable only when every registered
// identity has one canonical verdict and every excluded callback is explicit.
// These tests are deliberately pure: they exercise the evidence validator and
// concurrency calculation without starting a compiler worker.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveVitestMaxConcurrency } from "../scripts/test262-concurrency.mjs";
import {
  evaluateTest262Completeness,
  getTest262ShardCompletionPath,
  TEST262_COMPLETION_MANIFEST_SCHEMA,
} from "../scripts/validate-test262-completeness.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const runner = readFileSync(resolve(ROOT, "scripts/run-test262-vitest.sh"), "utf8");
const validator = resolve(ROOT, "scripts/validate-test262-completeness.mjs");

function row(file: string, status: string): string {
  return JSON.stringify({ file, category: "language", status });
}

function manifest(
  chunkIndex: number,
  registeredPaths: string[],
  verdictCount: number,
  proposalExclusions: string[] = [],
  officialExclusions: string[] = [],
  callbacksSettled = registeredPaths.length,
) {
  return {
    schema: TEST262_COMPLETION_MANIFEST_SCHEMA,
    runTimestamp: "5215-test",
    chunkIndex,
    chunkTotal: 2,
    target: "gc",
    registeredTests: registeredPaths.length,
    registeredPaths,
    recordedRows: verdictCount,
    canonicalVerdicts: verdictCount,
    exclusions: {
      proposal: { count: proposalExclusions.length, paths: proposalExclusions },
      official: { count: officialExclusions.length, paths: officialExclusions },
    },
    callbacksStarted: registeredPaths.length,
    callbacksSettled,
    allCallbacksSettled: callbacksSettled === registeredPaths.length,
  };
}

function runValidatorCli(
  jsonl: string,
  manifests: ReturnType<typeof manifest>[],
  options: { expectedShards?: number; expectedPaths?: string[] } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "js2-test262-5215-"));
  try {
    const input = join(directory, "results.jsonl");
    writeFileSync(input, jsonl);
    const args = [validator, "--input", input];
    if (options.expectedShards !== undefined) args.push("--expected-shards", String(options.expectedShards));
    for (const [index, value] of manifests.entries()) {
      const path = join(directory, `shard-${index}.complete.json`);
      writeFileSync(path, JSON.stringify(value));
      args.push("--manifest", path);
    }
    if (options.expectedPaths !== undefined) {
      const path = join(directory, "expected-paths.txt");
      writeFileSync(path, options.expectedPaths.join("\n") + "\n");
      args.push("--expected-paths-file", path);
    }
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("#5215 Test262 verdict completeness", () => {
  it("accepts a complete run even when conformance rows are fail/compile_error/timeout", () => {
    const paths = ["test/pass.js", "test/fail.js", "test/ce.js", "test/timeout.js", "test/skip.js"];
    const jsonl = paths
      .map((path, index) => row(path, ["pass", "fail", "compile_error", "compile_timeout", "skip"][index]))
      .join("\n");
    const result = evaluateTest262Completeness(jsonl, [manifest(0, paths, paths.length)], {
      expectedShardCount: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.stats.canonicalVerdicts).toBe(5);
  });

  it("rejects an incomplete shard even when a later complete shard exists", () => {
    const first = manifest(0, ["test/a.js", "test/missing.js", "test/c.js"], 2, [], [], 2);
    const second = manifest(1, ["test/d.js"], 1);
    const result = evaluateTest262Completeness(
      [row("test/a.js", "pass"), row("test/c.js", "fail"), row("test/d.js", "pass")].join("\n"),
      [first, second],
      { expectedShardCount: 2 },
    );
    expect(result.ok).toBe(false);
    expect(result.stats.missing).toEqual(["test/missing.js"]);
    expect(result.errors.some((error) => error.code === "callbacks-unsettled")).toBe(true);
    expect(result.errors.some((error) => error.code === "missing-verdict-identity")).toBe(true);
  });

  it("counts proposal and official-scope exclusions explicitly", () => {
    const selected = ["test/official.js", "test/staging/proposal.js", "test/nonofficial.js"];
    const result = evaluateTest262Completeness(
      row(selected[0], "compile_error"),
      [manifest(0, selected, 1, [selected[1]], [selected[2]])],
      { expectedShardCount: 1, expectedPaths: selected },
    );
    expect(result.ok).toBe(true);
    expect(result.stats.explicitExclusions).toBe(2);
  });

  it("rejects an exact-filter extra path and a missing selected path", () => {
    const selected = ["test/selected-a.js", "test/selected-b.js"];
    const result = evaluateTest262Completeness(
      [row(selected[0], "pass"), row("test/out-of-filter.js", "pass")].join("\n"),
      [manifest(0, selected, 2)],
      { expectedShardCount: 1, expectedPaths: selected },
    );
    expect(result.ok).toBe(false);
    expect(result.stats.missing).toEqual([selected[1]]);
    expect(result.stats.unexpected).toEqual(["test/out-of-filter.js"]);
  });

  it("rejects an expected filter identity absent from registeredPaths", () => {
    const expected = ["test/selected.js", "test/vanished.js"];
    const result = evaluateTest262Completeness(row(expected[0], "pass"), [manifest(0, [expected[0]], 1)], {
      expectedShardCount: 1,
      expectedPaths: expected,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "manifest-scope-mismatch")).toBe(true);
  });

  it("rejects duplicate identities and malformed JSONL rows", () => {
    const result = evaluateTest262Completeness(
      [row("test/duplicate.js", "fail"), row("test/duplicate.js", "pass"), "not-json"].join("\n"),
      [manifest(0, ["test/duplicate.js"], 2)],
      { expectedShardCount: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "duplicate-verdict-identity")).toBe(true);
    expect(result.errors.some((error) => error.code === "malformed-jsonl")).toBe(true);
  });

  it("rejects missing shard manifests rather than trusting a partial JSONL", () => {
    const result = evaluateTest262Completeness(row("test/only.js", "pass"), [], { expectedShardCount: 1 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "missing-shard-manifest")).toBe(true);
  });

  it("CLI blocks an incomplete shard even when a later complete shard is present", () => {
    const first = manifest(0, ["test/a.js", "test/missing.js"], 1, [], [], 1);
    const second = manifest(1, ["test/b.js"], 1);
    const result = runValidatorCli([row("test/a.js", "fail"), row("test/b.js", "pass")].join("\n"), [first, second], {
      expectedShards: 2,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("INCOMPLETE");
    expect(result.stderr).toContain("missing-verdict-identity");
  });

  it("CLI accepts ordinary fail and compile_error rows as complete evidence", () => {
    const paths = ["test/fail.js", "test/compile-error.js"];
    const result = runValidatorCli(
      [row(paths[0], "fail"), row(paths[1], "compile_error")].join("\n"),
      [manifest(0, paths, 2)],
      {
        expectedShards: 1,
        expectedPaths: paths,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("COMPLETE");
  });

  it("CLI rejects a filter identity missing from registeredPaths", () => {
    const expected = ["test/selected.js", "test/vanished.js"];
    const result = runValidatorCli(row(expected[0], "pass"), [manifest(0, [expected[0]], 1)], {
      expectedShards: 1,
      expectedPaths: expected,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("manifest-scope-mismatch");
  });
});

describe("#5215 concurrency controls", () => {
  it("passes an exact path filter to the production completeness gate and rejects ambiguous unions", () => {
    expect(runner).toContain('completeness_args+=(--expected-paths-file "$TEST262_PATH_FILTER_FILE")');
    expect(runner).toContain("TEST262_PATH_FILTER and TEST262_PATH_FILTER_FILE cannot be combined");
  });

  it("validates before report construction and canonical publication", () => {
    const gate = runner.indexOf("scripts/validate-test262-completeness.mjs");
    const report = runner.indexOf("scripts/build-test262-report.mjs");
    const reportSymlink = runner.indexOf('ln -sf "$(basename "$RUN_REPORT")"');
    const completed = runner.indexOf('echo "COMPLETED:');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(report);
    expect(report).toBeLessThan(reportSymlink);
    expect(reportSymlink).toBeLessThan(completed);
  });

  it("bounds only Test262 callbacks by the active compiler pool", () => {
    expect(resolveVitestMaxConcurrency({ TEST262_TARGET: "standalone", COMPILER_POOL_SIZE: "1" })).toBe(1);
    expect(resolveVitestMaxConcurrency({ TEST262_TARGET: "gc", COMPILER_POOL_SIZE: "2" })).toBe(2);
    expect(resolveVitestMaxConcurrency({ TEST262_TARGET: "gc", COMPILER_POOL_SIZE: "64" })).toBe(32);
    expect(resolveVitestMaxConcurrency({ VITEST_MAX_FORKS: "1" })).toBe(32);
  });

  it("gives each shard a distinct completion evidence path", () => {
    const jsonl = "/tmp/test262-results-5215.jsonl";
    expect(getTest262ShardCompletionPath(jsonl, 0, 2)).not.toBe(getTest262ShardCompletionPath(jsonl, 1, 2));
    expect(getTest262ShardCompletionPath(jsonl, 0, 2)).toBe("/tmp/test262-results-5215.shard-1-of-2.complete.json");
  });
});
