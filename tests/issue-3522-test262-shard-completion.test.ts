// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3522 / #4402 — Test262 shard completion must fail closed.
 *
 * Vitest exits 1 both for ordinary conformance failures and when its test-file
 * fork dies. The workflow therefore cannot use the exit code to distinguish a
 * complete failing shard from a partial JSONL left by an OOM. These assertions
 * pin the independent parent heap and the afterAll marker contract on every
 * workflow that can publish or compare Test262 evidence.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const sharded = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf8");
const refresh = readFileSync(resolve(ROOT, ".github/workflows/refresh-baseline.yml"), "utf8");
const runner = readFileSync(resolve(ROOT, "tests/test262-shared.ts"), "utf8");

function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name} missing`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("#3522 Test262 shard completion evidence", () => {
  it("gives every shard-producing Vitest parent a 1 GiB heap", () => {
    expect(job(sharded, "test262-shard")).toContain('VITEST_FORK_MAX_OLD_SPACE_SIZE: "1024"');
    expect(job(sharded, "test262-shard-mg")).toContain('VITEST_FORK_MAX_OLD_SPACE_SIZE: "1024"');
    expect(job(refresh, "test262-shard")).toContain('VITEST_FORK_MAX_OLD_SPACE_SIZE: "1024"');
  });

  it("writes the completion marker only from the shard afterAll hook", () => {
    const afterAllStart = runner.indexOf("  afterAll(() => {");
    expect(afterAllStart).toBeGreaterThan(-1);
    expect(runner.slice(0, afterAllStart)).not.toContain("writeFileSync(\n      SHARD_COMPLETION_PATH");
    expect(runner.slice(afterAllStart)).toContain("writeFileSync(\n      SHARD_COMPLETION_PATH");
    expect(runner).toContain("registeredTests: myTests.length");
    expect(runner).toContain("recordedRows: summary.total");
  });

  it("rejects a missing marker before any shard workflow accepts exit code 1", () => {
    for (const [label, workflowJob] of [
      ["static", job(sharded, "test262-shard")],
      ["merge-group", job(sharded, "test262-shard-mg")],
      ["refresh", job(refresh, "test262-shard")],
    ] as const) {
      expect(workflowJob, label).toContain(
        'completion_marker="benchmarks/results/${TEST262_RESULT_PREFIX}-results-${RUN_TIMESTAMP}.jsonl.complete.json"',
      );
      expect(workflowJob, label).toContain('if [ ! -s "$completion_marker" ]');
      expect(workflowJob, label).toContain("refusing partial JSONL evidence");
      expect(workflowJob, label).toContain(".jsonl.complete.json");
    }
  });
});
