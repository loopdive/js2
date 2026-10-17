// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const quality = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const antiRot = readFileSync(resolve(root, ".github/workflows/eval-interpreter-lane.yml"), "utf8");

// These are deliberately structural wiring controls, not eval verdicts.
// Fail closed on an absent/ambiguous step instead of checking the whole file
// for an environment flag that may belong to an unrelated job.
function step(workflow: string, name: string): string {
  const matches = workflow
    .split(/(?=^ {6}- name: )/m)
    .filter((part) => part.split("\n")[0] === `      - name: ${name}`);
  if (matches.length !== 1) throw new Error(`expected exactly one step: ${name}`);
  return matches[0]!;
}

function qualityProblems(workflow: string): string[] {
  const prepare = step(workflow, "Prepare Test262 harness inputs for changed root tests");
  const run = step(workflow, "Changed root test files must pass (#3008)");
  const problems: string[] = [];
  if (!/^ {10}node scripts\/build-runtime-eval-provider\.mjs$/m.test(prepare)) {
    problems.push("full provider preparation");
  }
  if (!/^ {10}NODE_OPTIONS: --max-old-space-size=3072$/m.test(prepare)) problems.push("builder heap");
  if (!prepare.includes("scripts/runtime-bundle-entry.ts")) problems.push("runtime bundle");
  if (!/^ {10}JS2WASM_EVAL_ENGINE: interpreter$/m.test(run)) problems.push("native engine");
  if (!/^ {10}TEST262_FULL_RUNTIME_EVAL: "1"$/m.test(run)) problems.push("full engine selection");
  if (!/^ {10}pnpm run test:changed-root$/m.test(run)) problems.push("unchanged root runner");
  return problems;
}

function antiRotProblems(workflow: string): string[] {
  const build = step(workflow, "Build and verify the native interpreter provider");
  const guards = step(workflow, "Run native interpreter semantic guards");
  const problems: string[] = [];
  if (!build.includes("scripts/runtime-bundle-entry.ts")) problems.push("runtime bundle");
  if (!/^ {10}node scripts\/build-runtime-eval-provider\.mjs$/m.test(build)) {
    problems.push("full provider preparation");
  }
  if (!/^ {10}VITEST_FORK_MAX_OLD_SPACE_SIZE: "3072"$/m.test(guards)) problems.push("worker heap");
  for (const flag of ["--pool=forks", "--poolOptions.forks.singleFork=true", "--no-file-parallelism"]) {
    if (!guards.includes(flag)) problems.push(`serialized guard: ${flag}`);
  }
  return problems;
}

describe("#6810 executable native eval CI contract", () => {
  it("prepares and selects the full provider for the unchanged changed-root runner", () => {
    expect(qualityProblems(quality)).toEqual([]);
  });

  it("rejects refusal-only preparation even when imports would link", () => {
    expect(
      qualityProblems(
        quality.replace(
          "node scripts/build-runtime-eval-provider.mjs\n",
          "node scripts/build-runtime-eval-provider.mjs --refusal-only\n",
        ),
      ),
    ).toContain("full provider preparation");
  });

  it("rejects interpreter selection without opting into the executable engine", () => {
    expect(qualityProblems(quality.replace('          TEST262_FULL_RUNTIME_EVAL: "1"\n', ""))).toContain(
      "full engine selection",
    );
  });

  it("rejects an absent or ambiguous named preparation step", () => {
    const name = "Prepare Test262 harness inputs for changed root tests";
    expect(() => qualityProblems(quality.replace(name, "unrelated preparation"))).toThrow(name);
    expect(() => qualityProblems(`${quality}\n      - name: ${name}\n`)).toThrow(name);
  });

  it("prepares both bundles and bounded serialized anti-rot guards", () => {
    expect(antiRotProblems(antiRot)).toEqual([]);
  });

  it("rejects the anti-rot missing-runtime-bundle defect", () => {
    expect(antiRotProblems(antiRot.replace("scripts/runtime-bundle-entry.ts", "scripts/unrelated-entry.ts"))).toContain(
      "runtime bundle",
    );
  });

  it("rejects unbounded parallel guards and the default worker heap", () => {
    const broken = antiRot
      .replace("--poolOptions.forks.singleFork=true", "")
      .replace('          VITEST_FORK_MAX_OLD_SPACE_SIZE: "3072"\n', "");
    expect(antiRotProblems(broken)).toContain("serialized guard: --poolOptions.forks.singleFork=true");
    expect(antiRotProblems(broken)).toContain("worker heap");
  });

  it("retains semantic guards and authoritative floor enforcement", () => {
    const guards = step(antiRot, "Run native interpreter semantic guards");
    for (const file of [
      "issue-2928-refusal-provider",
      "issue-2929-cd-global-materialization",
      "issue-2960",
      "issue-1102",
      "issue-4197-consumer-mode-decl-getter",
      "issue-4242-no-removal",
    ]) {
      expect(guards).toContain(`tests/${file}.test.ts`);
    }
    expect(step(antiRot, "Measure the interpreter eval-code floor")).toContain(
      "pnpm run test:262 -- --official-scope-only",
    );
    const floor = step(antiRot, "Enforce the committed interpreter floor");
    expect(floor).toContain("report.summary.total !== floor.total");
    expect(floor).toContain("report.summary.pass < passFloor");
  });
});
