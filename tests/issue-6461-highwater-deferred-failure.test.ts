// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6461 — the #2097 standalone high-water floor must STILL BLOCK the merge
 * queue after being deferred to the end of `merge shard reports`.
 *
 * Why this file exists. The floor step now carries `continue-on-error: true`
 * so that the steps below it — above all the #1897 standalone regression
 * guard, the only thing in CI that prints WHICH standalone tests moved — run
 * on a breach instead of being cut off. That flag alone would silently turn a
 * REQUIRED gate into a warning: the step goes green, the job goes green, and a
 * −174 walks into `main` exactly the way it did on 2026-09-13.
 *
 * The two halves are therefore one contract, and a future cleanup that removes
 * either half must fail here rather than in the merge queue four hours later:
 *
 *   (a) the floor step is non-fatal AT THAT POINT   (`continue-on-error`, `id:`)
 *   (b) a LATER step in the SAME job re-raises it   (`outcome == 'failure'` → exit 1)
 *   (c) the #1897 standalone regression guard sits BETWEEN them, which is the
 *       entire point of the deferral
 *
 * Parsed as text, not YAML: the assertion is about the literal shape a reader
 * (and a reviewer) sees, and the repo has no YAML parser dependency.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = resolve(ROOT, ".github/workflows/test262-sharded.yml");

const yaml = readFileSync(WORKFLOW, "utf-8");
const lines = yaml.split("\n");

/** Index of the first line whose text contains `needle`, or -1. */
function lineOf(needle: string): number {
  return lines.findIndex((l) => l.includes(needle));
}

/** The step block (name line through the line before the next `- name:`). */
function stepBlock(nameLine: string): string {
  const start = lineOf(nameLine);
  expect(start, `step not found: ${nameLine}`).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && !/^ {6}- name: /.test(lines[end] ?? "")) end++;
  return lines.slice(start, end).join("\n");
}

const FLOOR = "- name: Standalone pass-count high-water floor (#2097)";
const DEFERRED = "- name: Fail on standalone high-water breach (deferred, #6461)";
const GUARD_1897 = "- name: Standalone regression guard (#1897)";

describe("#6461 — deferred #2097 floor keeps blocking the merge queue", () => {
  it("the floor step is identified and non-fatal at its own position", () => {
    const block = stepBlock(FLOOR);
    expect(block).toContain("id: standalone_highwater");
    expect(block).toContain("continue-on-error: true");
    expect(block).toContain("scripts/check-standalone-highwater.mjs");
  });

  it("a later step re-raises the breach, so the required check still fails", () => {
    const block = stepBlock(DEFERRED);
    // Keyed on the floor step's OUTCOME (its real result), not its
    // CONCLUSION — `continue-on-error` rewrites the conclusion to success.
    expect(block).toContain("steps.standalone_highwater.outcome == 'failure'");
    // `always()` so an earlier diagnostic failure cannot skip the re-raise.
    expect(block).toContain("always()");
    expect(block).toMatch(/exit 1/);
  });

  it("the #1897 per-test standalone guard runs BETWEEN the two — the point of the deferral", () => {
    const floor = lineOf(FLOOR);
    const guard = lineOf(GUARD_1897);
    const deferred = lineOf(DEFERRED);
    expect(guard).toBeGreaterThan(floor);
    expect(deferred).toBeGreaterThan(guard);
  });

  it("both halves live in the `merge shard reports` job", () => {
    const job = lineOf("  merge-report:");
    const nextJob = lines.findIndex((l, i) => i > job && /^ {2}[a-z0-9-]+:$/.test(l));
    expect(lineOf(FLOOR)).toBeGreaterThan(job);
    // `toBeLessThan(nextJob)` alone is satisfied by a MISSING step (index −1),
    // so assert presence first.
    expect(lineOf(DEFERRED)).toBeGreaterThan(job);
    expect(lineOf(DEFERRED)).toBeLessThan(nextJob);
  });

  it("continue-on-error is not applied to the re-raising step itself", () => {
    expect(stepBlock(DEFERRED)).not.toContain("continue-on-error");
  });
});

describe("#6461 — gate READ and ratchet WRITE key on the same metric", () => {
  /**
   * The premise this issue was filed under was that the scheduled
   * `baseline-summary-sync` ratchets the mark from a different producer or
   * metric than the gate asserts. It does not: both sides read
   * `full_summary.host_free_pass` out of a report built by
   * `build-test262-report.mjs --target standalone` over the shard matrix's own
   * merged JSONL. Pin that so a future edit to either side is a test failure
   * rather than a four-hour queue block.
   */
  it("the sync ratchets from the standalone report the shard matrix produced", () => {
    const sync = readFileSync(resolve(ROOT, ".github/workflows/baseline-summary-sync.yml"), "utf-8");
    expect(sync).toContain("SA_REPORT=/tmp/js2wasm-baselines/test262-standalone-report.json");
    expect(sync).toContain('--report "$SA_REPORT" --update');
    // Provenance is the MEASURED revision, never the sync job's own checkout.
    expect(sync).toContain("baseline_sha");
  });

  it("the gate asserts on the merge group's own merged standalone report", () => {
    expect(stepBlock(FLOOR)).toContain("--report merged-reports/test262-standalone-report-merged.json");
  });

  it("both paths resolve full_summary.host_free_pass", async () => {
    const mod = await import("../scripts/check-standalone-highwater.mjs");
    expect(String(mod.passFromReport)).toContain("host_free_pass");
    expect(String(mod.hostFreeFromReport)).toContain("host_free_pass");
  });
});
