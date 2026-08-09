// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3611 — the #2097 standalone high-water raise never ran on a queue merge.
 *
 * `promote-baseline` runs `check-standalone-highwater.mjs --update`. Measured
 * 2026-08-01 it was SKIPPED on **30 of 30** available push:main runs, so the
 * mark could only fall behind — and because a floor that is too LOW never
 * fires, nothing ever complained. With `refresh-baseline.yml` also disabled,
 * both paths that can raise the mark were dead.
 *
 * It was not the actor guard and not `success()` over `needs` (both needs were
 * `success` on all 30). On the #3448 HIT path the shard matrix is skipped;
 * `merge-report` survives only via its own `if: always() && …`, and GitHub
 * propagates that skip THROUGH it into any dependent lacking a status-check
 * function of its own.
 *
 * The fix adds `!cancelled()`. **That alone would be a worse bug than the one
 * it fixes** — it would also let the job promote a baseline after
 * `merge-report` FAILED. The explicit `needs.*.result == 'success'` terms
 * restore what the implicit `success()` was providing, and the tests below pin
 * both halves. Losing either one silently is the whole hazard.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const WF = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf8");

/** Slice a job block out by key, up to the next sibling job key. */
function job(name: string): string {
  const start = WF.indexOf(`\n  ${name}:\n`);
  expect(start, `job not found: ${name}`).toBeGreaterThanOrEqual(0);
  const next = WF.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? WF.slice(start) : WF.slice(start, start + 1 + next);
}

const promote = job("promote-baseline");

describe("#3611 promote-baseline must survive the #3448 HIT path", () => {
  it("is the job that carries the #2097 high-water raise", () => {
    // Positive control on the slice: if the raise ever moves out of this job,
    // every other assertion here is testing the wrong block.
    expect(promote).toContain("promote merged report to main baseline");
    expect(promote).toContain("check-standalone-highwater.mjs");
  });

  it("carries a status-check function, without which the skip propagates", () => {
    // `merge-report` runs under always() over skipped shards; a dependent with
    // only an implicit success() is skipped along with them. This is the
    // single character-level property that made the raise dead for 30/30 runs.
    expect(promote).toMatch(/if:[\s\S]*?!cancelled\(\)/);
  });

  it("still refuses to promote when either dependency did not succeed", () => {
    // THE SAFETY HALF. `!cancelled()` re-enables the job unconditionally, so
    // the failure semantics the implicit success() provided must be restored
    // explicitly — otherwise a FAILED merge-report would promote its baseline,
    // which is far worse than a stale high-water mark.
    expect(promote).toContain("needs.merge-report.result == 'success'");
    expect(promote).toContain("needs.mg-artifact-probe.result == 'success'");
  });

  it("keeps the guards that predate this change", () => {
    // #2947 — an IR-first dispatch must never promote its pass-set.
    expect(promote).toContain("!(github.event_name == 'workflow_dispatch' && inputs.ir_first)");
    // The bot-actor guard, and the event restriction.
    expect(promote).toContain("github.actor != 'github-actions[bot]'");
    expect(promote).toContain("github.event_name == 'push'");
    expect(promote).toContain("needs: [merge-report, mg-artifact-probe]");
  });

  it("does not use bare always(), which would also run on cancellation", () => {
    // Comments must be stripped first: this job's own prose EXPLAINS the
    // `always()` on merge-report, so a naive slice matches the explanation
    // rather than the condition. (Caught by this test failing on exactly
    // that — a substring assertion over YAML is only as good as its slice.)
    const code = promote
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    const ifBlock = code.slice(code.indexOf("if:"), code.indexOf("name:"));
    expect(ifBlock).toContain("!cancelled()");
    expect(ifBlock).not.toMatch(/\balways\(\)/);
  });
});

describe("#3611 the sibling job that proved the actor value", () => {
  /**
   * This job is the positive control that disproved the issue's stated root
   * cause: it is gated on the actor being `github-merge-queue[bot]` and it RAN
   * on all 30 runs, which pins `github.actor` and therefore proves every
   * conjunct of promote-baseline's old `if:` was true while it skipped anyway.
   *
   * Pinned here because that control only works while this gate keeps naming
   * the actor explicitly — if it is ever relaxed, the disproof in the issue
   * stops being reproducible from the workflow alone.
   */
  it("still names github-merge-queue[bot] explicitly", () => {
    expect(WF).toContain("github.event_name == 'push' && github.actor == 'github-merge-queue[bot]'");
  });

  it("is a different job from the one carrying the raise", () => {
    // The two names differ by a few words and mislead a reader skimming a run
    // summary: one `promote …` job was green on all 30 runs, and it is not the
    // one that raises the mark.
    expect(WF).toContain("promote root baseline + cache per-SHA for queue merge");
    expect(promote).not.toContain("promote root baseline + cache per-SHA");
  });
});
