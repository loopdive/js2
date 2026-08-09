// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The required quality gate and the expensive Test262 matrix start in parallel
 * for merge groups. Once quality fails, Test262 cannot rescue that group, so CI
 * cancels only the exact sibling run instead of spending the rest of its shard
 * wave. These workflow-contract assertions keep the cancellation fail-safe.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const workflow = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const jobStart = workflow.indexOf("  cancel-test262-on-quality-failure:");
const jobEnd = workflow.indexOf("\n  linear-tests:", jobStart);
const job = workflow.slice(jobStart, jobEnd);

describe("quality-failure Test262 cancellation", () => {
  it("runs only after merge-group quality has actually failed", () => {
    expect(jobStart).toBeGreaterThanOrEqual(0);
    expect(jobEnd).toBeGreaterThan(jobStart);
    expect(job).toContain("needs: quality");
    expect(job).toContain(
      "if: ${{ always() && github.event_name == 'merge_group' && needs.quality.result == 'failure' }}",
    );
    expect(job).toContain("actions: write");
  });

  it("selects only the active Test262 sibling for the exact merge-group SHA", () => {
    expect(job).toContain("event=merge_group&head_sha=${HEAD_SHA}&per_page=100");
    expect(job).toContain('[ "$run_name" = "Test262 Sharded" ]');
    expect(job).toContain('[ "$run_path" = ".github/workflows/test262-sharded.yml" ]');
    expect(job).toContain('[ "$run_sha" = "$HEAD_SHA" ]');
    expect(job).toContain('[ "$run_event" = "merge_group" ]');
    expect(job).toContain("queued|in_progress");
    expect(job).toContain("actions/runs/${run_id}/cancel");
  });

  it("does one lookup without polling or retrying", () => {
    expect(job).toContain("One exact-SHA lookup, with no polling or retry loop");
    expect(job).not.toContain("sleep ");
    expect(job).not.toContain("for attempt in");
  });
});
