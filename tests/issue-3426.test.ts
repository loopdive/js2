/**
 * #3426 — exact same-SHA JS-host Test262 noise quarantine.
 *
 * These tests execute the real CLI because the base-main workflow consumes its
 * first matching summary lines and exit code, not an internal helper API.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadHostNoiseQuarantine,
  validateHostNoiseQuarantineManifest,
  type HostNoiseQuarantineManifest,
} from "../scripts/diff-test262.js";

interface FixtureRow {
  file: string;
  status: string;
  wasm_sha?: string | null;
  compile_ms?: number;
  error_category?: string;
}

const manifest = JSON.parse(
  readFileSync("scripts/test262-host-noise-quarantine.json", "utf-8"),
) as HostNoiseQuarantineManifest;
const passFlipPaths = manifest.entries
  .filter((entry) => entry.observations.some((observation) => observation.kind === "pass_flip"))
  .map((entry) => entry.path);
const unionOnlyPassFlipPath = manifest.entries.find(
  (entry) =>
    entry.observations.length === 1 && entry.observations.some((observation) => observation.kind === "pass_flip"),
)?.path;
const intersectionPassFlipPath = manifest.entries.find(
  (entry) =>
    entry.observations.length === manifest.provenance.canaries.length &&
    entry.observations.some((observation) => observation.kind === "pass_flip"),
)?.path;

function runDiff(baselineRows: FixtureRow[], candidateRows: FixtureRow[], extraArgs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "issue-3426-diff-"));
  try {
    const baseline = join(dir, "baseline.jsonl");
    const candidate = join(dir, "candidate.jsonl");
    writeFileSync(baseline, baselineRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(candidate, candidateRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/diff-test262.ts", baseline, candidate, "--quiet", ...extraArgs],
      { cwd: process.cwd(), encoding: "utf-8" },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function workflowParsedTimeoutCount(output: string): number {
  const parsed = output.match(/Compile timeouts \(pass → compile_timeout\): (\d+)/)?.[1];
  expect(parsed, "workflow-parsed compile-timeout summary line").toBeDefined();
  return Number(parsed);
}

function extractWorkflowRunBlock(stepName: string): string {
  const workflow = readFileSync(".github/workflows/test262-sharded.yml", "utf-8");
  const lines = workflow.split("\n");
  const nameIndex = lines.findIndex((line) => line.includes(`- name: ${stepName}`));
  expect(nameIndex, `step "${stepName}" not found`).toBeGreaterThan(-1);
  const runIndex = lines.findIndex((line, index) => index > nameIndex && /^\s+run: \|/.test(line));
  expect(runIndex, `run block for "${stepName}" not found`).toBeGreaterThan(nameIndex);
  const runIndent = lines[runIndex].match(/^(\s*)/)![1].length;
  const raw: string[] = [];
  for (let index = runIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "") {
      raw.push("");
      continue;
    }
    if (line.match(/^(\s*)/)![1].length <= runIndent) break;
    raw.push(line);
  }
  const minIndent = Math.min(
    ...raw.filter((line) => line.trim() !== "").map((line) => line.match(/^(\s*)/)![1].length),
  );
  return raw.map((line) => (line.trim() === "" ? "" : line.slice(minIndent))).join("\n");
}

function runCompileTimeWorkflowGuard(diffOutput: string) {
  const dir = mkdtempSync(join(tmpdir(), "issue-3426-compile-guard-"));
  try {
    const diffPath = join(dir, "cat-diff.txt");
    writeFileSync(diffPath, diffOutput);
    const shell = extractWorkflowRunBlock("Compile-time regression guard (#1942)").replaceAll(
      "/tmp/cat-diff.txt",
      '"$TEST_CAT_DIFF_FILE"',
    );
    const result = spawnSync("bash", ["-c", shell], {
      encoding: "utf-8",
      env: {
        ...process.env,
        TEST_CAT_DIFF_FILE: diffPath,
        COMPILE_TIMEOUT_THRESHOLD: "25",
        AGG_COMPILE_TIME_PCT_THRESHOLD: "20",
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function timeoutChurnRows(forwardPaths: string[], reversePaths: string[]) {
  const baseline: FixtureRow[] = [];
  const candidate: FixtureRow[] = [];
  for (const file of forwardPaths) {
    baseline.push({ file, status: "pass", wasm_sha: "aaaaaaaaaaaa", compile_ms: 100 });
    candidate.push({ file, status: "compile_timeout", wasm_sha: null });
  }
  for (const file of reversePaths) {
    baseline.push({ file, status: "compile_timeout", wasm_sha: null });
    candidate.push({ file, status: "pass", wasm_sha: "bbbbbbbbbbbb", compile_ms: 100 });
  }
  return { baseline, candidate };
}

describe("#3426 — host Test262 same-SHA noise quarantine", () => {
  it("pins the audited canary provenance and exact union/intersection sets", () => {
    const loaded = loadHostNoiseQuarantine();
    expect(manifest).toMatchObject({
      schema_version: 2,
      lane: "js-host",
      provenance: {
        canaries: [
          {
            canary_run_id: 29632875780,
            compiler_sha: "852c40a9f5167a2a959d53faa066cb0753b623cc",
            artifact_id: 8426392963,
            compiler_pool_size: 4,
            pass_flips: 360,
            non_pass_status_noise: 150,
            unstable_paths: 510,
          },
          {
            canary_run_id: 29643714720,
            compiler_sha: "dae79d5a311a0bf683341230c39e6c5a7f6176ad",
            artifact_id: 8429653584,
            compiler_pool_size: 4,
            pass_flips: 366,
            non_pass_status_noise: 165,
            unstable_paths: 531,
          },
        ],
      },
      counts: {
        canary_runs: 2,
        pass_flip_observations: 726,
        non_pass_status_noise_observations: 315,
        union_paths: 932,
        intersection_paths: 109,
      },
    });
    expect(loaded.paths.size).toBe(932);
    expect(loaded.intersectionPaths.size).toBe(109);
    expect(new Set(manifest.entries.map((entry) => entry.path)).size).toBe(932);
    expect(unionOnlyPassFlipPath).toBe("test/annexB/built-ins/Date/prototype/getYear/length.js");
    expect(intersectionPassFlipPath).toBe("test/annexB/built-ins/Date/prototype/setYear/length.js");
  });

  it("rejects an observation that is not sourced to a recorded same-SHA canary", () => {
    const invalid = structuredClone(manifest);
    invalid.entries[0].observations[0].canary_run_id = 99999999999;
    expect(() => validateHostNoiseQuarantineManifest(invalid)).toThrow(
      "invalid/duplicate/unsorted Test262 host-noise observation",
    );
  });

  it("passes and fully reports bidirectional churn on canary-known host paths", () => {
    const regressedPath = unionOnlyPassFlipPath!;
    const improvedPath = intersectionPassFlipPath!;
    const result = runDiff(
      [
        { file: regressedPath, status: "pass", wasm_sha: "aaaaaaaaaaaa", compile_ms: 100 },
        { file: improvedPath, status: "fail", wasm_sha: "bbbbbbbbbbbb", compile_ms: 200 },
      ],
      [
        { file: regressedPath, status: "fail", wasm_sha: "cccccccccccc", compile_ms: 110 },
        { file: improvedPath, status: "pass", wasm_sha: "dddddddddddd", compile_ms: 210 },
      ],
    );

    expect(result.status).toBe(0);
    expect(result.output).toContain("Host canary quarantine (#3426): 2 observed transition(s)");
    expect(result.output).toContain(`QUARANTINED ${regressedPath}: pass → fail [union-only]`);
    expect(result.output).toContain(`QUARANTINED ${improvedPath}: fail → pass [intersection]`);
    expect(result.output).toContain("Regressions with wasm-hash change: 0");
    expect(result.output).toContain("Improvements (other → pass): 0");
  });

  it("does not let an equal quarantined improvement mask a one-way stable regression", () => {
    const stablePath = "test/built-ins/Array/stable-one-way-regression.js";
    const improvedPath = passFlipPaths[1];
    const result = runDiff(
      [
        { file: stablePath, status: "pass", wasm_sha: "aaaaaaaaaaaa" },
        { file: improvedPath, status: "fail", wasm_sha: "bbbbbbbbbbbb" },
      ],
      [
        { file: stablePath, status: "fail", wasm_sha: "cccccccccccc" },
        { file: improvedPath, status: "pass", wasm_sha: "dddddddddddd" },
      ],
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain("Host stable-path fine-gate net: -1 (0 improvements − 1 regressions)");
    expect(result.output).toContain("GATE FAIL: net_per_test -1 < 0");
  });

  it("keeps a canary-known path strict in the standalone lane", () => {
    const quarantinedPath = passFlipPaths[0];
    const result = runDiff(
      [{ file: quarantinedPath, status: "pass", wasm_sha: "aaaaaaaaaaaa" }],
      [{ file: quarantinedPath, status: "fail", wasm_sha: "bbbbbbbbbbbb" }],
      ["--exclude-leaky-baseline-regressions"],
    );

    expect(result.status).toBe(1);
    expect(result.output).not.toContain("Host canary quarantine (#3426)");
    expect(result.output).toContain("Regressions with wasm-hash change: 1");
  });

  it("never lets the host quarantine weaken the uncatchable-trap ratchet", () => {
    const quarantinedPath = passFlipPaths[0];
    const result = runDiff(
      [{ file: quarantinedPath, status: "pass", wasm_sha: "aaaaaaaaaaaa" }],
      [{ file: quarantinedPath, status: "fail", wasm_sha: "bbbbbbbbbbbb", error_category: "oob" }],
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain(`QUARANTINED ${quarantinedPath}: pass → fail`);
    expect(result.output).toContain('GATE FAIL: trap category "oob" grew 0 → 1 (+1)');
  });

  it("matches exact paths only, never arbitrary lookalikes", () => {
    const arbitraryPath = `${passFlipPaths[0]}.not-in-canary`;
    const result = runDiff(
      [{ file: arbitraryPath, status: "pass", wasm_sha: "aaaaaaaaaaaa" }],
      [{ file: arbitraryPath, status: "fail", wasm_sha: "bbbbbbbbbbbb" }],
    );

    expect(result.status).toBe(1);
    expect(result.output).not.toContain(`QUARANTINED ${arbitraryPath}`);
    expect(result.output).toContain("Regressions with wasm-hash change: 1");
  });

  it("keeps the workflow-parsed compile-time lines authoritative for stable paths", () => {
    const [timeoutNoisePath, aggregateNoisePath] = passFlipPaths;
    const stableTimeoutPath = "test/built-ins/Array/stable-timeout.js";
    const stableAggregatePath = "test/built-ins/Array/stable-aggregate.js";
    const result = runDiff(
      [
        { file: timeoutNoisePath, status: "pass", wasm_sha: "aaaaaaaaaaaa", compile_ms: 100 },
        { file: stableTimeoutPath, status: "pass", wasm_sha: "bbbbbbbbbbbb", compile_ms: 100 },
        { file: aggregateNoisePath, status: "pass", wasm_sha: "cccccccccccc", compile_ms: 100 },
        { file: stableAggregatePath, status: "pass", wasm_sha: "dddddddddddd", compile_ms: 100 },
      ],
      [
        { file: timeoutNoisePath, status: "compile_timeout", wasm_sha: null },
        { file: stableTimeoutPath, status: "compile_timeout", wasm_sha: null },
        { file: aggregateNoisePath, status: "pass", wasm_sha: "eeeeeeeeeeee", compile_ms: 10000 },
        { file: stableAggregatePath, status: "pass", wasm_sha: "ffffffffffff", compile_ms: 100 },
      ],
    );

    expect(result.status).toBe(0);
    const firstTimeout = result.output.match(/Compile timeouts \(pass → compile_timeout\): (\d+)/)?.[1];
    const firstAggregate = result.output.match(
      /Aggregate compile time \(shared \d+ tests\):[^\n]*Δ ([+-]?\d+\.\d+)%/,
    )?.[1];
    expect(firstTimeout).toBe("1");
    expect(firstAggregate).toBe("+0.0");
    expect(result.output).toContain("Raw host pass→compile_timeout transitions before canary quarantine: 2");
    expect(result.output).toContain("Host canary-quarantined pass→compile_timeout noise: 1");
    expect(result.output).toContain("Raw host aggregate before canary quarantine");
    expect(result.output).toContain("Host canary-quarantined aggregate contribution");
  });

  it("lets the unchanged host workflow guard absorb symmetric stable timeout churn", () => {
    const forwardPaths = Array.from({ length: 26 }, (_, index) => `test/stable/forward-${index}.js`);
    const reversePaths = Array.from({ length: 26 }, (_, index) => `test/stable/reverse-${index}.js`);
    const rows = timeoutChurnRows(forwardPaths, reversePaths);
    const result = runDiff(rows.baseline, rows.candidate);

    expect(result.status).toBe(0);
    expect(workflowParsedTimeoutCount(result.output)).toBe(0);
    expect(result.output).toContain("Stable host pass→compile_timeout transitions before symmetric offset: 26");
    expect(result.output).toContain("Stable host compile_timeout→pass reverse transitions: 26");
    expect(result.output).toContain("Stable host directional compile_timeout growth");
    expect(result.output).toContain("compile_timeout population: baseline 26 → current 26 (Δ 0)");

    const guard = runCompileTimeWorkflowGuard(result.output);
    expect(guard.status).toBe(0);
    expect(guard.output).toContain("pass→compile_timeout=0 (threshold 25)");
  });

  it("keeps one-way stable timeout growth blocking and excludes quarantined reverse noise from the offset", () => {
    const forwardPaths = Array.from({ length: 26 }, (_, index) => `test/stable/one-way-${index}.js`);
    const quarantinedReversePaths = passFlipPaths.slice(0, 26);
    const rows = timeoutChurnRows(forwardPaths, quarantinedReversePaths);
    const result = runDiff(rows.baseline, rows.candidate);

    expect(result.status).toBe(0);
    expect(workflowParsedTimeoutCount(result.output)).toBe(26);
    expect(result.output).toContain("Stable host pass→compile_timeout transitions before symmetric offset: 26");
    expect(result.output).toContain("Stable host compile_timeout→pass reverse transitions: 0");
    expect(result.output).toContain("Raw host compile_timeout→pass transitions before canary quarantine: 26");
    expect(result.output).toContain("Host canary-quarantined compile_timeout→pass noise: 26");

    const guard = runCompileTimeWorkflowGuard(result.output);
    expect(guard.status).toBe(1);
    expect(guard.output).toContain("pass→compile_timeout=26 (threshold 25)");
    expect(guard.output).toContain("COMPILE-TIME regression");
  });

  it("keeps standalone on the original forward-only timeout count", () => {
    const forwardPaths = Array.from({ length: 26 }, (_, index) => `test/standalone/forward-${index}.js`);
    const reversePaths = Array.from({ length: 26 }, (_, index) => `test/standalone/reverse-${index}.js`);
    const rows = timeoutChurnRows(forwardPaths, reversePaths);
    const result = runDiff(rows.baseline, rows.candidate, ["--exclude-leaky-baseline-regressions"]);

    expect(result.status).toBe(0);
    expect(workflowParsedTimeoutCount(result.output)).toBe(26);
    expect(result.output).not.toContain("Stable host compile_timeout→pass reverse transitions");
    expect(result.output).not.toContain("Host canary quarantine (#3426)");
  });
});
