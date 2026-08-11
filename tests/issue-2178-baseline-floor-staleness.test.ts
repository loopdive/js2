// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2178 — baseline-floor staleness self-check.
 *
 * The standalone regression guard (#1897) and host regression gate diff every
 * PR against a *floor* in `loopdive/js2wasm-baselines`. The floor advances via
 * `promote-baseline` on every push to main. When a rapid burst of main pushes
 * (the merge-queue "thrash" of 2026-06-16) cancels the intermediate push:main
 * sharded run before it reaches `promote-baseline`, the floor stops advancing
 * and every PR on current main is blocked against a stale floor.
 *
 * The fix has two parts:
 *   1. Per-SHA `push` concurrency group in test262-sharded.yml so no push:main
 *      run can cancel another (pinned below by reading the workflow YAML).
 *   2. `scripts/check-baseline-floor-staleness.mjs` — surfaces the deadlock by
 *      counting test262-RELEVANT commits the floor lags main, with an
 *      early-exit so the breach decision is cheap. This file pins the two
 *      load-bearing pure functions without the network cost of the CLI.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathsTouchTest262, countRelevantDrift } from "../scripts/check-baseline-floor-staleness.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

describe("#2178 — pathsTouchTest262 mirrors the test262-paths allowlist", () => {
  it("flags compiler source and test262 chunk/config changes", () => {
    expect(pathsTouchTest262("src/codegen/index.ts")).toBe(true);
    expect(pathsTouchTest262("tests/test262-chunk7.test.ts")).toBe(true);
    expect(pathsTouchTest262("package.json")).toBe(true);
    expect(pathsTouchTest262("pnpm-lock.yaml")).toBe(true);
    expect(pathsTouchTest262(".github/workflows/test262-sharded.yml")).toBe(true);
    expect(pathsTouchTest262("tests/test262-slow-tests.json")).toBe(true);
    // A mixed blob: any single relevant line makes the commit relevant.
    expect(pathsTouchTest262("README.md\nsrc/foo.ts\ndocs/x.md")).toBe(true);
  });

  it("ignores docs / plan / baseline-churn changes", () => {
    expect(pathsTouchTest262("README.md")).toBe(false);
    expect(pathsTouchTest262("docs/architecture/codegen-axes.md")).toBe(false);
    expect(pathsTouchTest262("plan/issues/2178-x.md")).toBe(false);
    expect(pathsTouchTest262("benchmarks/results/test262-current.json")).toBe(false);
    expect(pathsTouchTest262("")).toBe(false);
    // The [skip ci] baseline-refresh commits touch only summary JSON + docs —
    // they must NOT count as drift (that's the whole point of the relevant
    // filter; otherwise the floor's own promotion commit registers as lag).
    expect(
      pathsTouchTest262(
        "benchmarks/results/test262-current.json\npublic/benchmarks/results/test262-report.json\nREADME.md",
      ),
    ).toBe(false);
  });

  it("stays in lockstep with scripts/test262-paths-match.sh", () => {
    // The JS mirror and the shell source of truth must agree — for EVERY
    // target, since the per-lane merge_group gating in test262-sharded.yml
    // reads the shell script while the floor-staleness check reads the mirror.
    // Spot-check a representative path set through BOTH and assert identical
    // verdicts.
    const cases = [
      ".github/actions/setup-node-pnpm/action.yml",
      "src/a/b.ts",
      "tests/test262-chunk1.test.ts",
      "tests/test262-runner.ts",
      "scripts/diff-test262.ts",
      "scripts/build-quickjs-eval-provider.mjs",
      "scripts/quickjs-eval-provider.mjs",
      "scripts/runtime-eval-provider.mjs",
      "scripts/quickjs-artifact/build.sh",
      "tests/test262-slow-tests.json",
      "tests/test262-slow-tests-standalone.json",
      "tests/test262-slow-tests-future-lane.json",
      "README.md",
      "docs/x.md",
      "plan/y.md",
      "benchmarks/results/test262-current.json",
    ];
    const sh = resolve(ROOT, "scripts/test262-paths-match.sh");
    for (const target of ["any", "host", "standalone"] as const) {
      const args = target === "any" ? [sh] : [sh, "--target", target];
      for (const p of cases) {
        const shellVerdict = execFileSync("bash", args, { input: p, encoding: "utf8" }).trim() === "true";
        expect(pathsTouchTest262(p, target), `${p} @ ${target}`).toBe(shellVerdict);
      }
    }
  });
});

describe("per-lane test262 path gating (merge_group single-lane runs)", () => {
  // The merge_group `changes` job drops a whole shard lane (66 js-host or 36
  // standalone jobs) when the queued diff provably cannot move it. That is only
  // sound while the lane-exclusive set stays explicitly audited — everything
  // else, `src/**` above all, must stay both-lane.
  it("narrows the audited lane-specific paths", () => {
    expect(pathsTouchTest262("tests/test262-slow-tests-standalone.json", "standalone")).toBe(true);
    expect(pathsTouchTest262("tests/test262-slow-tests-standalone.json", "host")).toBe(false);
    expect(pathsTouchTest262("tests/test262-slow-tests.json", "host")).toBe(true);
    expect(pathsTouchTest262("tests/test262-slow-tests.json", "standalone")).toBe(false);
    // Both still count as test262-relevant for the coarse "run at all?" question.
    expect(pathsTouchTest262("tests/test262-slow-tests-standalone.json")).toBe(true);
    expect(pathsTouchTest262("tests/test262-slow-tests.json")).toBe(true);

    for (const p of [
      "scripts/build-quickjs-eval-provider.mjs",
      "scripts/quickjs-eval-provider.mjs",
      "scripts/runtime-eval-provider.mjs",
      "scripts/quickjs-artifact/build.sh",
    ]) {
      expect(pathsTouchTest262(p, "host"), p).toBe(false);
      expect(pathsTouchTest262(p, "standalone"), p).toBe(true);
      expect(pathsTouchTest262(p), p).toBe(true);
    }
  });

  it("keeps the entire compiler both-lane — `target: standalone` is a flag, not a source tree", () => {
    for (const p of [
      "src/compiler.ts",
      "src/codegen/expressions.ts",
      "src/codegen-linear/index.ts",
      "src/runtime.ts",
      "src/runtime/wasi-polyfill.ts",
    ]) {
      expect(pathsTouchTest262(p, "host"), p).toBe(true);
      expect(pathsTouchTest262(p, "standalone"), p).toBe(true);
    }
  });

  it("keeps shared runner/config paths both-lane", () => {
    for (const p of [
      "package.json",
      "pnpm-lock.yaml",
      "vitest.config.ts",
      "tests/test262-runner.ts",
      "tests/test262-shared.ts",
      "tests/test262-chunk1.test.ts",
      "scripts/test262-worker.mjs",
      ".github/workflows/test262-sharded.yml",
      // The matcher itself: a change to the gating logic must re-validate
      // everything it could newly skip.
      "scripts/test262-paths-match.sh",
      // An unclassified future weight-map variant falls back to both lanes
      // rather than silently becoming irrelevant.
      "tests/test262-slow-tests-future-lane.json",
    ]) {
      expect(pathsTouchTest262(p, "host"), p).toBe(true);
      expect(pathsTouchTest262(p, "standalone"), p).toBe(true);
    }
  });

  it("never lets a mixed diff drop a lane that one of its paths touches", () => {
    const blob = "tests/test262-slow-tests-standalone.json\nsrc/compiler.ts";
    expect(pathsTouchTest262(blob, "host")).toBe(true);
    expect(pathsTouchTest262(blob, "standalone")).toBe(true);
  });

  it("irrelevant paths stay irrelevant for every lane", () => {
    for (const p of ["README.md", "docs/x.md", "plan/y.md", "benchmarks/results/test262-current.json"]) {
      expect(pathsTouchTest262(p, "any"), p).toBe(false);
      expect(pathsTouchTest262(p, "host"), p).toBe(false);
      expect(pathsTouchTest262(p, "standalone"), p).toBe(false);
    }
  });
});

describe("#2178 — countRelevantDrift counts relevant lag with early-exit", () => {
  it("returns null for an unreachable floor SHA (staleness undetermined)", () => {
    const drift = countRelevantDrift("0000000000000000000000000000000000000000", "HEAD", 25);
    expect(drift).toBeNull();
  });

  it("reports an exact zero-drift for floor == HEAD", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const drift = countRelevantDrift(head, "HEAD", 25);
    expect(drift).not.toBeNull();
    expect(drift!.total).toBe(0);
    expect(drift!.relevant).toBe(0);
    expect(drift!.exact).toBe(true);
  });

  it("early-exits once relevant lag exceeds the threshold (lower-bound, not exact)", () => {
    // Find a floor far enough back that >2 relevant commits exist, then assert
    // a maxBehind of 1 forces a non-exact early-exit. We walk back until the
    // range has enough relevant commits or we run out of history.
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    // Count total reachable commits so we don't ask for more than exist.
    const depth = Number(
      execFileSync("git", ["rev-list", "--count", head], {
        encoding: "utf8",
      }).trim(),
    );
    if (depth < 30) return; // shallow checkout — skip rather than flake
    const floor = execFileSync("git", ["rev-parse", `${head}~25`], {
      encoding: "utf8",
    }).trim();
    const drift = countRelevantDrift(floor, head, 1);
    expect(drift).not.toBeNull();
    // With maxBehind=1 and a 25-commit window, we expect either an exact count
    // ≤1 (rare — almost no relevant commits) or an early-exit lower bound >1.
    if (!drift!.exact) {
      expect(drift!.relevant).toBeGreaterThan(1);
    }
  });
});

describe("#2178 — push:main concurrency group is per-SHA (non-cancellable)", () => {
  it("test262-sharded.yml keys the push group by github.sha so push runs never cancel each other", () => {
    const yml = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf8");
    // The group expression must add a per-SHA suffix ONLY for push events.
    expect(yml).toMatch(
      /group:\s*test262-sharded-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}\$\{\{ github\.event_name == 'push' && format\('-\{0\}', github\.sha\) \|\| '' \}\}/,
    );
    // PR-only cancellation must be preserved (push/dispatch/merge_group queue).
    expect(yml).toMatch(/cancel-in-progress:\s*\$\{\{ github\.event_name == 'pull_request' \}\}/);
  });
});
