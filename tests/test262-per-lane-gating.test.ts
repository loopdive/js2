// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Per-lane test262 gating in .github/workflows/test262-sharded.yml.
 *
 * The `changes` job classifies a queued merge_group diff per LANE
 * (`scripts/test262-paths-match.sh --target host|standalone`) and drops the
 * shard matrix for any lane the change provably cannot move — 66 js-host jobs
 * or 36 standalone jobs that would otherwise run and be thrown away.
 *
 * Skipping conformance coverage is exactly the kind of change that is silently
 * wrong, so this file pins the invariants that make it safe:
 *   1. Every fail-safe path in `detect` emits ALL lanes (uncertainty ⇒ run).
 *   2. Consumers read the lane outputs as `!= 'false'`, so a missing output
 *      means "ran", never "skipped".
 *   3. Each lane's report/guard steps are gated on THAT lane, so a skipped
 *      lane cannot fail the required check on a missing JSONL.
 *   4. The #1956 group artifact — which #3448 lets `promote-baseline` publish
 *      a baseline straight from — is only published when BOTH lanes ran.
 *   5. push / workflow_dispatch always run both lanes (they promote baselines).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/test262-sharded.yml");
const workflowText = readFileSync(WORKFLOW_PATH, "utf8");
const MATCHER = resolve(ROOT, "scripts/test262-paths-match.sh");

// Text slicing rather than a YAML parse: `yaml` is not a direct dependency and
// the rest of the workflow tests in this repo read the file as text too.

/** Text of one top-level job, from its `  <name>:` key to the next one. */
function job(name: string): string {
  const start = workflowText.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name} missing`).toBeGreaterThan(-1);
  const rest = workflowText.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Text of one step within a job, from its `- name:` to the next step. */
function step(jobName: string, stepName: string): string {
  const jobText = job(jobName);
  const start = jobText.indexOf(`      - name: ${stepName}\n`);
  expect(start, `step "${stepName}" not found in job ${jobName}`).toBeGreaterThan(-1);
  const rest = jobText.slice(start);
  const next = rest.slice(1).indexOf("\n      - name: ");
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The single-line `if:` condition of a step. */
function stepIf(jobName: string, stepName: string): string {
  const m = step(jobName, stepName).match(/\n {8}if: (.*)/);
  expect(m, `step "${stepName}" in ${jobName} has no single-line if:`).toBeTruthy();
  return (m as RegExpMatchArray)[1].trim();
}

/** A `KEY: value` entry from a job-level or step-level env block. */
function envEntry(text: string, key: string): string {
  const m = text.match(new RegExp(`\\n\\s*${key}: (.*)`));
  expect(m, `env ${key} not found`).toBeTruthy();
  return (m as RegExpMatchArray)[1].trim();
}

/** Run the real `detect` step body against a synthetic merge_group diff. */
function runDetect(diff: string | null, { eventName = "merge_group" } = {}) {
  const detectBody = step("changes", "Detect test262-relevant changes");
  const runIdx = detectBody.indexOf("\n        run: |\n");
  expect(runIdx, "detect step body missing").toBeGreaterThan(-1);
  const script = detectBody
    .slice(runIdx + "\n        run: |\n".length)
    .split("\n")
    .map((l) => (l.startsWith("          ") ? l.slice(10) : l))
    .join("\n");

  const dir = mkdtempSync(join(tmpdir(), "detect-"));
  const scriptPath = join(dir, "detect.sh");
  const outPath = join(dir, "github_output");
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  writeFileSync(scriptPath, script);
  writeFileSync(outPath, "");
  // Stub `git` so the step sees exactly the diff under test. `diff === null`
  // simulates a failing `git diff` (the fail-safe path).
  writeFileSync(
    join(binDir, "git"),
    `#!/bin/bash\ncase "$1" in\n  diff) [ "$SYNTH_FAIL" = "1" ] && exit 128; printf '%s\\n' "$SYNTH_DIFF"; exit 0;;\n  *) exit 0;;\nesac\n`,
    { mode: 0o755 },
  );

  try {
    execFileSync("bash", [scriptPath], {
      encoding: "utf8",
      stdio: "ignore",
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GITHUB_OUTPUT: outPath,
        EVENT_NAME: eventName,
        MG_BASE_SHA: "base",
        MG_HEAD_SHA: "head",
        SYNTH_DIFF: diff ?? "",
        SYNTH_FAIL: diff === null ? "1" : "0",
      },
    });

    const verdict: Record<string, string> = {};
    for (const line of readFileSync(outPath, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) verdict[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return verdict;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("test262 per-lane gating — the `detect` step", () => {
  it("runs both lanes for a compiler change", () => {
    expect(runDetect("src/codegen/expressions.ts")).toEqual({
      run_shards: "true",
      run_host: "true",
      run_standalone: "true",
    });
  });

  it("drops the js-host lane for a standalone-only shard-weight refresh", () => {
    expect(runDetect("tests/test262-slow-tests-standalone.json")).toEqual({
      run_shards: "true",
      run_host: "false",
      run_standalone: "true",
    });
  });

  it.each([
    "scripts/build-quickjs-eval-provider.mjs",
    "scripts/quickjs-eval-provider.mjs",
    "scripts/runtime-eval-provider.mjs",
    "scripts/quickjs-artifact/build.sh",
  ])("classifies standalone eval-provider path %s as standalone-only", (path) => {
    expect(runDetect(path)).toEqual({
      run_shards: "true",
      run_host: "false",
      run_standalone: "true",
    });
  });

  it("drops the standalone lane for a js-host-only shard-weight refresh", () => {
    expect(runDetect("tests/test262-slow-tests.json")).toEqual({
      run_shards: "true",
      run_host: "true",
      run_standalone: "false",
    });
  });

  it("keeps a lane the moment ANY changed path touches it", () => {
    expect(runDetect("tests/test262-slow-tests-standalone.json\nsrc/compiler.ts")).toEqual({
      run_shards: "true",
      run_host: "true",
      run_standalone: "true",
    });
    expect(runDetect("tests/test262-slow-tests-standalone.json\ntests/test262-slow-tests.json")).toEqual({
      run_shards: "true",
      run_host: "true",
      run_standalone: "true",
    });
  });

  it("run_shards stays the OR of the two lanes (unchanged meaning for existing consumers)", () => {
    for (const diff of [
      "src/compiler.ts",
      "tests/test262-slow-tests.json",
      "tests/test262-slow-tests-standalone.json",
      "README.md",
      "docs/x.md\nplan/y.md",
    ]) {
      const v = runDetect(diff);
      const anyLane = v.run_host === "true" || v.run_standalone === "true";
      expect(v.run_shards, diff).toBe(String(anyLane));
      // And it must still agree with the untargeted matcher, which other
      // callers (test262-pr-stub.yml, the stale-baseline guard) rely on.
      const coarse = execFileSync("bash", [MATCHER], { input: diff, encoding: "utf8" }).trim();
      expect(v.run_shards, diff).toBe(coarse);
    }
  });

  it("skips everything for a docs-only queue entry", () => {
    expect(runDetect("README.md\ndocs/x.md")).toEqual({
      run_shards: "false",
      run_host: "false",
      run_standalone: "false",
    });
  });

  it("FAIL-SAFE: every uncertain path emits all lanes", () => {
    const both = { run_shards: "true", run_host: "true", run_standalone: "true" };
    expect(runDetect(null), "git diff failed").toEqual(both);
    expect(runDetect(""), "empty diff").toEqual(both);
    // Non-merge_group events never narrow: push/workflow_dispatch promote
    // BOTH baselines, so a single-lane run there would publish a half-empty one.
    for (const eventName of ["push", "workflow_dispatch", "pull_request"]) {
      expect(runDetect("tests/test262-slow-tests-standalone.json", { eventName }), eventName).toEqual(both);
    }
  });
});

describe("test262 per-lane gating — workflow wiring", () => {
  it("`changes` exposes the per-lane outputs", () => {
    const changes = job("changes");
    expect(envEntry(changes, "run_host")).toContain("steps.detect.outputs.run_host");
    expect(envEntry(changes, "run_standalone")).toContain("steps.detect.outputs.run_standalone");
  });

  it("the merge_group matrix is built from the lane verdict", () => {
    const s = step("changes", "Compute merge_group shard matrix (#3431)");
    expect(envEntry(s, "RUN_HOST")).toContain("steps.detect.outputs.run_host");
    expect(envEntry(s, "RUN_STANDALONE")).toContain("steps.detect.outputs.run_standalone");
    expect(s).toContain("--lanes");
    // A missing verdict must select the lane, not drop it.
    expect(s).toContain('if [ "$RUN_HOST" != "false" ]');
    expect(s).toContain('if [ "$RUN_STANDALONE" != "false" ]');
  });

  it("the merge_group matrix cannot cascade-skip through the provider's skipped probe ancestor", () => {
    const shardJob = job("test262-shard-mg");
    expect(shardJob).toContain("needs: [changes, runtime-eval-provider]");
    expect(shardJob).toMatch(/if: \|\n\s+always\(\) &&/);
    expect(shardJob).toContain("needs.changes.result == 'success'");
    expect(shardJob).toContain("needs.runtime-eval-provider.result == 'success'");
  });

  it("every lane flag treats a missing output as 'ran' (`!= 'false'`, never `== 'true'`)", () => {
    for (const [jobName, flag] of [
      ["merge-report", "HOST_RAN"],
      ["merge-report", "STANDALONE_RAN"],
      ["regression-gate", "HOST_RAN"],
    ] as const) {
      const expr = envEntry(job(jobName), flag);
      const lane = flag === "HOST_RAN" ? "run_host" : "run_standalone";
      expect(expr, `${jobName}.${flag}`).toContain(`needs.changes.outputs.${lane} != 'false'`);
      // Still requires a shard job to have actually succeeded.
      expect(expr, `${jobName}.${flag}`).toContain("needs.test262-shard.result == 'success'");
      expect(expr, `${jobName}.${flag}`).toContain("needs.test262-shard-mg.result == 'success'");
    }
  });

  it("each lane's steps are gated on that lane", () => {
    const host = "env.HOST_RAN == 'true'";
    const standalone = "env.STANDALONE_RAN == 'true'";
    const expected: Array<[string, string]> = [
      ["Merge JS-host test262 JSONL results", host],
      ["Build merged JS-host test262 report", host],
      ["Catastrophic regression guard (#1668)", host],
      ["Compile-time regression guard (#1942, #3447)", host],
      ["Merge standalone test262 JSONL results", standalone],
      ["Build merged standalone test262 report", standalone],
      ["Standalone pass-count high-water floor (#2097)", standalone],
      ["Standalone regression guard (#1897)", standalone],
    ];
    for (const [name, guard] of expected) {
      expect(stepIf("merge-report", name), name).toBe(guard);
    }
  });

  it("regression-gate is host-lane and no-ops when js-host did not run", () => {
    // The whole job consumes js-host JSONLs only; the standalone lane's gates
    // live in merge-report. It must not look for artifacts that do not exist.
    // No `SHARDS_RAN` env KEY (the prose mentions it) — the job must not have
    // a lane-agnostic flag left to accidentally gate on.
    expect(job("regression-gate")).not.toMatch(/\n {6}SHARDS_RAN:/);
    expect(job("regression-gate")).not.toContain("env.SHARDS_RAN");
    expect(stepIf("regression-gate", "No-op pass (no merged test262 report to diff)")).toBe("env.HOST_RAN != 'true'");
    for (const name of [
      "Download shard artifacts",
      "Merge JS-host test262 JSONL results",
      "Compare against current main baseline",
      "Hard-error stability gate (#1853)",
    ]) {
      expect(stepIf("regression-gate", name), name).toContain("env.HOST_RAN == 'true'");
    }
  });

  it("the #1956 group artifact is published ONLY when both lanes ran", () => {
    // #3448 lets a push:main promote a baseline straight from this artifact.
    // A single-lane group would promote a baseline with an empty side; not
    // publishing makes the probe MISS and run the full two-lane matrix.
    const cond = stepIf("merge-report", "Publish group results for predecessor diffing (#1956)");
    expect(cond).toContain("env.HOST_RAN == 'true'");
    expect(cond).toContain("env.STANDALONE_RAN == 'true'");
    expect(cond).toContain("github.event_name == 'merge_group'");
  });

  it("the required-check decision still keys off SHARDS_RAN, not a single lane", () => {
    // "merge shard reports" must stay green/red on the same conditions as
    // before — per-lane gating narrows WHICH steps run, not whether the
    // required context is produced (the cascade-skip trap).
    expect(stepIf("merge-report", "Fail if required test262 shards did not succeed")).toBe(
      "env.SHARDS_RAN != 'true' && env.SHARD_SKIP_OK != 'true'",
    );
    expect(stepIf("merge-report", "No-op pass (shards intentionally skipped)")).toBe(
      "env.SHARDS_RAN != 'true' && env.SHARD_SKIP_OK == 'true'",
    );
  });

  it("the static push/workflow_dispatch matrix still carries BOTH targets", () => {
    // promote-baseline publishes both lanes' baselines from these runs.
    const shardJob = job("test262-shard");
    expect(shardJob).toContain("- name: js-host");
    expect(shardJob).toContain("- name: standalone");
    expect(shardJob).toContain("test262_target: gc");
    expect(shardJob).toContain("test262_target: standalone");
  });
});
