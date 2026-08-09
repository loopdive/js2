// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4153 — `test262-sharded.yml`'s header must describe the gating it actually has.
 *
 * ## Why this file exists
 *
 * The workflow's `on:` header claimed "full 57-shard test262 runs at PR-time AND
 * in merge_group". That describes the pre-#2519 serial-queue model; the #2519
 * slim-down moved the heavy matrix off `pull_request` and the comment outlived
 * it by months. A reader who believes it concludes that a green PR-level
 * test262 check means "no conformance regressions" — it means nothing of the
 * sort, because on a `pull_request` the two REQUIRED contexts this workflow
 * publishes green-SKIP with `SHARDS_RAN: false`.
 *
 * That gap is not hypothetical: PR #4074 was parked three times on an apparent
 * `null_deref` regression PR-level checks could not have surfaced, and the
 * cause turned out to be a baseline/candidate scope asymmetry (#4141).
 *
 * #4153 replaced the comment. This file stops the comment and the conditions
 * from drifting apart again — a prose-only fix has no guard of its own, which
 * is exactly how the first one rotted for months without anyone noticing.
 *
 * ## What is asserted, and why THAT
 *
 * Three things, each independently able to fail:
 *
 *   1. THE CONDITIONS — `test262-shard`'s `if:` admits only `push` and
 *      `workflow_dispatch`, and never mentions `pull_request`;
 *      `test262-shard-mg`'s `if:` requires `merge_group`. These are the facts
 *      the header asserts, read from the jobs themselves.
 *   2. THE HEADER — the stale claim is gone and the header states plainly that
 *      the matrix does not run at PR time. Checking only (1) would let the
 *      comment rot again while the conditions stayed correct, which is the
 *      original defect.
 *   3. THE WIRING — `merge-report`'s `SHARDS_RAN` is derived from the two
 *      matrix jobs' results, which is *why* a PR-time skip surfaces as a green
 *      no-op rather than a failure.
 *
 * If PR-time shards are ever deliberately restored, (1) and (2) fail together
 * and force the header to be updated with them. That is the intended behaviour,
 * not a false positive.
 *
 * ## Non-vacuity
 *
 * String assertions over a large file pass easily for the wrong reason, so the
 * extraction is checked before it is trusted: `jobBlock` is asserted to return
 * a non-empty block containing an `if:` for each job it slices, and the
 * predicate is exercised against a mutated copy of the real condition (one with
 * `pull_request` spliced in) to show it goes red. A test that cannot be made to
 * fail is not evidence.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const WORKFLOW = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf8");

/** The `on:` header block — everything above the first top-level `jobs:` key. */
function headerBlock(text: string): string {
  const end = text.indexOf("\njobs:");
  expect(end, "workflow has no top-level `jobs:` key").toBeGreaterThan(0);
  return text.slice(0, end);
}

/** Slice one job out of `jobs:` by name, up to the next sibling job key. */
function jobBlock(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, `job not found: ${name}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z_][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The `if:` expression of a job block, with comment lines stripped. */
function jobIf(block: string): string {
  const m = block.match(/\n {4}if:[ \t]*\|?\n?((?: {6}.*\n)+)/) ?? block.match(/\n {4}if:[ \t]*(.*)\n/);
  expect(m, "job has no `if:` condition").not.toBeNull();
  return (m![1] ?? "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
    .trim();
}

/** Does this `if:` expression admit a `pull_request` event? */
function admitsPullRequest(condition: string): boolean {
  return /pull_request/.test(condition);
}

describe("#4153 — the heavy test262 matrix is not PR-gated, and the header says so", () => {
  it("extracts real, non-empty job blocks (guards the assertions below from passing vacuously)", () => {
    for (const name of ["test262-shard", "test262-shard-mg", "merge-report"]) {
      const block = jobBlock(WORKFLOW, name);
      expect(block.length, `${name}: empty block`).toBeGreaterThan(100);
      expect(block, `${name}: block leaked into a sibling job`).toContain(`  ${name}:`);
    }
  });

  it("test262-shard runs only on push and workflow_dispatch — never on a pull_request", () => {
    const condition = jobIf(jobBlock(WORKFLOW, "test262-shard"));

    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
    expect(admitsPullRequest(condition)).toBe(false);
  });

  it("test262-shard-mg is merge_group-only", () => {
    const condition = jobIf(jobBlock(WORKFLOW, "test262-shard-mg"));

    expect(condition).toContain("github.event_name == 'merge_group'");
    expect(admitsPullRequest(condition)).toBe(false);
  });

  it("the predicate has teeth — a condition that DID admit pull_request is rejected", () => {
    const real = jobIf(jobBlock(WORKFLOW, "test262-shard"));
    const mutated = real.replace("github.event_name == 'push'", "github.event_name == 'pull_request'");

    // The mutation must actually have applied, or the assertion below is vacuous.
    expect(mutated).not.toBe(real);
    expect(admitsPullRequest(mutated)).toBe(true);
  });

  it("SHARDS_RAN is derived from the two matrix jobs, so a PR-time skip reports as a green no-op", () => {
    const block = jobBlock(WORKFLOW, "merge-report");

    expect(block).toContain("SHARDS_RAN:");
    expect(block).toContain("needs.test262-shard.result");
    expect(block).toContain("needs.test262-shard-mg.result");
  });

  it("the header no longer claims PR-time shard runs", () => {
    const header = headerBlock(WORKFLOW);

    // The exact stale claim that #4153 removed.
    expect(header).not.toContain("test262 runs at PR-time AND in merge_group");
    expect(header).not.toMatch(/developers see test262\s*\n?\s*#?\s*regressions on PR push/);
  });

  it("the header states the matrix does not run at PR time", () => {
    const header = headerBlock(WORKFLOW);

    expect(header).toMatch(/does NOT run at PR time/i);
    expect(header).toMatch(/merge_group/);
  });
});
