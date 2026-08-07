import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4211 — the conformance-sync ordering bug.
 *
 * `sync-conformance-numbers.mjs` writes TWO derived numbers into the prose docs:
 * the JS-host line from `benchmarks/results/test262-current.json`, and the
 * standalone line from `benchmarks/results/test262-standalone-highwater.json`.
 *
 * `baseline-summary-sync.yml` writes the high-water mark itself, in the same
 * job. So if the sync runs BEFORE the raise, the job commits a new mark next to
 * a README synced from the old one — main ships internally inconsistent and
 * every open PR then fails the `quality` gate's `sync:conformance:check` until
 * some unrelated PR happens to carry the repair commit.
 *
 * That is not hypothetical: it fired three times on 2026-08-07 and parked nine
 * PRs in one morning.
 *
 * This is a workflow-ordering invariant, so the guard is a workflow-ordering
 * assertion. It fails if anyone reorders the calls back.
 */

const WORKFLOW = resolve(__dirname, "..", ".github", "workflows", "baseline-summary-sync.yml");

/** Line indices (0-based) of every line matching `needle`. */
function lineIndicesOf(lines: readonly string[], needle: string): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    // Ignore comment-only lines: the fix documents itself in comments that
    // legitimately mention both script names.
    if (line.trim().startsWith("#")) return;
    if (line.includes(needle)) out.push(i);
  });
  return out;
}

describe("#4211 — baseline-summary-sync syncs the docs AFTER raising the high-water mark", () => {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const raises = lineIndicesOf(lines, "check-standalone-highwater.mjs");
  const syncs = lineIndicesOf(lines, "sync-conformance-numbers.mjs");

  it("PRECONDITION: the workflow still invokes both scripts", () => {
    // If either disappears the invariant below is vacuous, so assert the
    // premise rather than letting the real test pass for the wrong reason.
    expect(raises.length).toBeGreaterThan(0);
    expect(syncs.length).toBeGreaterThan(0);
  });

  it("PRECONDITION: both the fresh path and the re-anchor path are present", () => {
    // The job has two code paths that commit the mark: the initial attempt and
    // the re-anchor/retry loop. Both must raise, and both must sync.
    expect(raises.length).toBeGreaterThanOrEqual(2);
    expect(syncs.length).toBeGreaterThanOrEqual(2);
  });

  it("every high-water raise is followed by a doc sync before the next raise", () => {
    // For each raise, there must be a sync after it and before the following
    // raise — i.e. the mark that a given path commits was the one the docs were
    // generated from.
    for (let i = 0; i < raises.length; i++) {
      const raise = raises[i]!;
      const nextRaise = raises[i + 1] ?? Number.POSITIVE_INFINITY;
      const syncBetween = syncs.some((s) => s > raise && s < nextRaise);
      expect(
        syncBetween,
        `high-water raise at line ${raise + 1} is not followed by a ` +
          `sync-conformance-numbers call before the next raise. The job would ` +
          `commit a new mark next to docs generated from the old one (#4211).`,
      ).toBe(true);
    }
  });

  it("no doc sync precedes the first high-water raise", () => {
    // The original bug in its exact shape: a sync at the top of the job,
    // reading a mark that is raised further down.
    const firstRaise = raises[0]!;
    const strayEarlySync = syncs.find((s) => s < firstRaise);
    expect(
      strayEarlySync,
      `sync-conformance-numbers at line ${(strayEarlySync ?? 0) + 1} runs ` +
        `BEFORE the first high-water raise at line ${firstRaise + 1} — it would ` +
        `read the pre-raise mark (#4211).`,
    ).toBeUndefined();
  });
});
