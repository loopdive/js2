import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname ?? ".", "..");

function readRepo(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

function standaloneGuardBlock(): string {
  const workflow = readRepo(".github/workflows/test262-sharded.yml");
  const start = workflow.indexOf("- name: Standalone regression guard (#1897)");
  const end = workflow.indexOf("- name: Stale-baseline guard (#1668)", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

function writeJsonl(path: string, entries: unknown[]) {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

describe("#1897 standalone test262 merge gate", () => {
  it("runs inside the required merge-report job after the standalone report is built", () => {
    const workflow = readRepo(".github/workflows/test262-sharded.yml");
    const standaloneReport = workflow.indexOf("- name: Build merged standalone test262 report");
    const standaloneGuard = workflow.indexOf("- name: Standalone regression guard (#1897)");
    const staleGuard = workflow.indexOf("- name: Stale-baseline guard (#1668)");

    expect(standaloneReport).toBeGreaterThanOrEqual(0);
    expect(standaloneGuard).toBeGreaterThan(standaloneReport);
    expect(staleGuard).toBeGreaterThan(standaloneGuard);

    const mergeReportJob = workflow.slice(workflow.indexOf("merge-report:"), workflow.indexOf("  regression-gate:"));
    expect(mergeReportJob).toContain("name: merge shard reports");
    expect(mergeReportJob).toContain("- name: Standalone regression guard (#1897)");
  });

  it("diffs the merged standalone JSONL against the standalone baseline with no extra shard run", () => {
    const guard = standaloneGuardBlock();

    // Gated on the STANDALONE lane specifically, not on "any shard ran": a
    // merge_group whose queued change cannot move standalone schedules no
    // standalone shards, and this guard would then fail the required check on
    // a missing merged JSONL. STANDALONE_RAN is only 'true' when standalone
    // shards actually ran, so the guard still fires on every run that has a
    // standalone report to gate.
    expect(guard).toContain("if: env.STANDALONE_RAN == 'true'");
    expect(guard).toContain('STANDALONE_REGRESSION_TOLERANCE: "15"');
    expect(guard).toContain("/tmp/cat-baselines/test262-standalone-current.jsonl");
    expect(guard).toContain("merged-reports/test262-standalone-results-merged.jsonl");
    expect(guard).toContain("No standalone baseline JSONL available");
    expect(guard).toContain("standalone merged JSONL missing/empty");
    expect(guard).not.toContain("node node_modules/vitest/dist/cli.js run");
  });

  it("gates on improvements minus wasm-changing regressions, with compile_timeout only reported as excluded flake", () => {
    const guard = standaloneGuardBlock();

    expect(guard).toContain("diff_exit");
    expect(guard).toContain('if [ "$diff_exit" -gt 1 ]; then');
    expect(guard).toContain("Regressions with wasm-hash change: [0-9]+");
    expect(guard).toContain("Improvements \\(other \u2192 pass\\): [0-9]+");
    expect(guard).toContain("Compile timeouts \\(pass \u2192 compile_timeout\\): [0-9]+");
    expect(guard).toContain("NET=$((IMP - REG))");
    expect(guard).toContain('if [ "$NET" -lt "$((0 - STANDALONE_REGRESSION_TOLERANCE))" ]; then');
    expect(guard).toContain("STANDALONE test262 regression");
  });

  it("documents that standalone rides the existing required check, not a new branch-protection context", () => {
    const policy = readRepo("docs/ci-policy.md");
    const branchProtection = readRepo("scripts/enable-branch-protection.sh");

    expect(policy).toContain("Standalone regression guard (#1897)");
    expect(policy).toContain("no branch-protection change is needed");
    // Pre-existing prose drift: the script's #1897 note now reads "needed NO
    // separate entry here and NO ruleset re-apply". Assert the CLAIM (no extra
    // required-check entry, no re-apply) rather than one exact sentence, so a
    // reworded comment doesn't fail a test about branch-protection semantics.
    expect(branchProtection).toMatch(/NO (new|separate) entry here and NO (branch-protection|ruleset) re-apply/);
    expect(branchProtection).toContain('"merge shard reports"');
    expect(branchProtection).not.toContain('"standalone regression guard"');
  });

  it("diff-test262 emits the flake-filtered counts consumed by the standalone guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-1897-diff-"));
    try {
      const baseline = join(dir, "baseline.jsonl");
      const candidate = join(dir, "candidate.jsonl");
      writeJsonl(baseline, [
        { file: "real-regression.js", status: "pass", wasm_sha: "aaaaaaaaaaaa" },
        { file: "real-improvement.js", status: "compile_error", wasm_sha: null },
        { file: "timeout-flake.js", status: "pass", wasm_sha: "cccccccccccc" },
        { file: "same-wasm-noise.js", status: "pass", wasm_sha: "dddddddddddd" },
      ]);
      writeJsonl(candidate, [
        { file: "real-regression.js", status: "compile_error", error_category: "wasm_compile", wasm_sha: null },
        { file: "real-improvement.js", status: "pass", wasm_sha: "bbbbbbbbbbbb" },
        { file: "timeout-flake.js", status: "compile_timeout", wasm_sha: null },
        { file: "same-wasm-noise.js", status: "fail", wasm_sha: "dddddddddddd" },
      ]);

      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "scripts/diff-test262.ts", baseline, candidate, "--quiet"],
        { cwd: ROOT, encoding: "utf-8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("=== Improvements (other \u2192 pass): 1 ===");
      expect(result.stdout).toContain("=== Compile timeouts (pass \u2192 compile_timeout): 1 ===");
      expect(result.stdout).toContain("=== Wasm-identical noise (pass \u2192 other, same wasm_sha): 1 ===");
      expect(result.stdout).toContain("=== Regressions with wasm-hash change: 1 ===");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
