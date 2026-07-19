// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3425 — Test262 baseline/merge-group compiler-pool compatibility.
 *
 * Compile timeout classification depends on compiler-pool contention. The
 * candidate merge-group run and the workflow that publishes its comparison
 * baseline therefore need the same default and event fallback. These focused
 * text assertions match the repository's existing workflow-contract tests and
 * require no YAML parser or network access.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const sharded = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf8");
const refresh = readFileSync(resolve(ROOT, ".github/workflows/refresh-baseline.yml"), "utf8");

function compilerPoolInputBlock(workflow: string): string {
  const match = workflow.match(/ {6}compiler_pool_size:\n([\s\S]*?)(?= {6}[a-z_]+:\n|\npermissions:)/);
  expect(match, "compiler_pool_size workflow_dispatch input not found").not.toBeNull();
  return match![0];
}

describe("#3425 — merge-group compiler pool reproduces the published Test262 baseline", () => {
  it("uses pool size 4 for the sharded dispatch default and non-dispatch fallback", () => {
    expect(compilerPoolInputBlock(sharded)).toContain('default: "4"');
    expect(sharded).toContain("COMPILER_POOL_SIZE: ${{ inputs.compiler_pool_size || '4' }}");
    expect(sharded).not.toContain("inputs.compiler_pool_size || '3'");
  });

  it("keeps the baseline refresh default and fallback on the same pool size", () => {
    expect(compilerPoolInputBlock(refresh)).toContain('default: "4"');
    expect(refresh).toContain("COMPILER_POOL_SIZE: ${{ inputs.compiler_pool_size || '4' }}");
  });

  it("documents the two-workflow compatibility contract and audited follow-up path", () => {
    expect(sharded).toContain("BASELINE-COMPATIBILITY CONTRACT (#3425)");
    expect(sharded).toContain("change BOTH workflows together");
  });
});
