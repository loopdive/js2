import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #4350 — refresh-baseline.yml exists to stop the test262 baseline going
// content-stale during a stretch of merges that never trigger
// test262-sharded.yml's promote-baseline (docs/CI-only pushes advance main
// without re-promoting). Its 8h cron is the only mechanism that breaks the
// loop:
//
//   stale baseline -> PRs show phantom net -1 -> auto-park -> nothing merges
//   -> no test262-relevant push -> baseline stays stale
//
// Observed 2026-08-10: the workflow had been disabled, its last successful run
// was three weeks earlier, the baseline reached 8h31m stale, and #4310/#4295
// were both parked on phantom single-test regressions whose identity changed
// every run. Both merged clean once the baseline was current.
//
// SCOPE LIMIT, stated so nobody mistakes this for full cover: the actual
// failure was GitHub-side workflow state (`disabled_manually`), which is not
// represented in the repository and therefore cannot be asserted here. This
// pins the in-repo half — that the scheduled trigger is not removed or
// silently widened — so the anti-staleness mechanism cannot be deleted by
// edit. A disabled workflow still needs the Actions UI to detect.
describe("#4350 — baseline refresh keeps its anti-staleness schedule", () => {
  const workflow = readFileSync(join(process.cwd(), ".github/workflows/refresh-baseline.yml"), "utf8");

  it("keeps a scheduled trigger alongside the manual one", () => {
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
  });

  it("runs at least every 8 hours", () => {
    const cron = workflow.match(/- cron:\s*"([^"]+)"/);
    expect(cron, "refresh-baseline.yml must declare a cron schedule").not.toBeNull();

    const [minute, hour] = (cron?.[1] ?? "").split(/\s+/);
    // Anchored off the top of the hour on purpose (#4350 context: :17 avoids
    // the Actions rush and the sibling baseline jobs at :23/:37).
    expect(minute).toMatch(/^\d+$/);

    // `*/N` — reject a regression to a once-daily or weekday-only cadence,
    // which would reopen the staleness window the issue is about.
    const everyN = hour.match(/^\*\/(\d+)$/);
    expect(everyN, `cron hour field "${hour}" must be */N so the refresh repeats intra-day`).not.toBeNull();
    expect(Number(everyN?.[1])).toBeLessThanOrEqual(8);
  });
});
