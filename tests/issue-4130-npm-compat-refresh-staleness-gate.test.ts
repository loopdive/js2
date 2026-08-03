// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4130) The npm-compat refresh workflow's staleness floor must measure the
 * COMMITTED artifact, not the one the job just regenerated.
 *
 * The failure this guards against is invisible by construction: the workflow
 * ran on every push to main, reported **success**, and committed nothing for
 * two days. Nothing was red. The only symptom was a dashboard that quietly
 * stopped moving — precisely the class of bug the workflow's own header says it
 * exists to prevent ("shipped stale twice in one session").
 *
 * So the guard is structural: assert the step ORDER and the wiring, because
 * when this breaks there is no output to assert on. Raw-text assertions match
 * `ci-quality-failfast.test.ts`; the repo carries no YAML parser, and step order
 * is a property of the file's text anyway.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const workflow = readFileSync(resolve(ROOT, ".github/workflows/npm-compat-refresh.yml"), "utf8");

const at = (needle: string): number => workflow.indexOf(needle);

describe("#4130 — the staleness floor measures the committed artifact", () => {
  it("captures the committed artifact's age BEFORE regenerating it", () => {
    const capture = at("id: committed");
    const regenerate = at("pnpm run generate:npm-compat");

    expect(capture, "a step with `id: committed` must exist").toBeGreaterThanOrEqual(0);
    expect(regenerate, "the regeneration step must exist").toBeGreaterThanOrEqual(0);
    // The whole bug in one assertion. Reading `generatedAt` after the
    // regeneration yields the age of the measurement just taken — always ~0 —
    // so the floor never fires and a busy queue defers forever.
    expect(capture).toBeLessThan(regenerate);
  });

  it("feeds the gate from that captured value, not from a re-read of the file", () => {
    expect(workflow).toContain("steps.committed.outputs.last_refresh");
    // A re-read AFTER regeneration is the regression: it would silently restore
    // the old behaviour while every assertion about the gate's flags still
    // passed. Pin that the gate step no longer reads the file itself.
    const gateBlock = workflow.slice(at("id: queue_gate"), at("- name: Promote"));
    expect(gateBlock).not.toContain('readFileSync("benchmarks/results/npm-compat.json"');
  });

  it("still passes a staleness floor to the gate", () => {
    expect(workflow).toMatch(/--stale-after-hours\s+\d+/);
  });

  it("gates promotion on the queue decision", () => {
    expect(workflow.slice(at("- name: Promote"))).toContain("steps.queue_gate.outputs.decision");
  });
});

describe("#4132 — the promotion commit must not run the pre-commit hook", () => {
  it("commits with --no-verify", () => {
    // This job installs dependencies, so husky's hook is live and runs
    // `test:changed-root`, which needs a merge base with `origin/main`. The
    // checkout is `fetch-depth: 1` with `persist-credentials: false` and the
    // push remote is `deploykey`, so there is no `origin/main` and the hook
    // aborts the commit. It stayed hidden until #4130 stopped the gate
    // deferring on every run — the step had simply never executed.
    const promote = workflow.slice(at("- name: Promote"));
    expect(promote).toMatch(/git commit[^\n]*--no-verify/);
  });

  it("keeps the [skip ci] marker that breaks the trigger loop", () => {
    expect(workflow.slice(at("- name: Promote"))).toContain("[skip ci]");
  });
});

describe("#4130 — the gate's own decision function", () => {
  it("defers a busy queue only while the artifact is fresh, and proceeds once it is stale", async () => {
    const { decide } = await import("../scripts/main-push-queue-gate.mjs");
    const busy = { force: false, queueLen: 3, staleAfterHours: 12 };

    // What the workflow produced before the fix: the just-regenerated file is
    // always ~0h old, so a busy queue deferred every single run.
    expect(decide({ ...busy, ageHours: 0 }).decision).toBe("defer");
    // What it produces now — the committed artifact's real age clears the floor.
    expect(decide({ ...busy, ageHours: 42 }).decision).toBe("proceed");
    expect(decide({ ...busy, ageHours: 12 }).decision).toBe("proceed");
    // A quiet queue never needed the floor at all.
    expect(decide({ ...busy, queueLen: 0, ageHours: 0 }).decision).toBe("proceed");
  });
});
