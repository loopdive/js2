import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #4350 — the test262 baseline must not go content-stale. Observed 2026-08-10:
// refresh-baseline.yml had been disabled, the baseline reached 8h31m stale, and
// #4310/#4295 were parked on phantom single-test regressions, because the merge
// queue diffed every group against that baseline:
//
//   stale baseline -> PRs show phantom net -1 -> auto-park -> nothing merges
//   -> no test262-relevant push -> baseline stays stale
//
// (#7551) That loop no longer exists. The merge queue gates on the IR current
// edition against the measurement of the exact base commit, never against the
// legacy baseline. The legacy baseline is promoted by the DAILY test262-sharded
// schedule after its gates pass, and refresh-baseline.yml is dispatch-only:
// it promotes without gates, so running it on a timer between daily audits
// would bank a regression unexamined. An age-based staleness alert backstops
// a daily promotion that does not land.
//
// SCOPE LIMIT, unchanged: a workflow disabled in the Actions UI is not
// represented in the repository and cannot be asserted here.
describe("#4350 — the baseline keeps exactly one scheduled refresher", () => {
  const read = (name: string) => readFileSync(join(process.cwd(), ".github/workflows", name), "utf8");
  const sharded = read("test262-sharded.yml");
  const refresh = read("refresh-baseline.yml");

  it("promotes from the daily test262-sharded schedule, after its gates", () => {
    const cron = sharded.match(/schedule:\n\s+- cron:\s*"([^"]+)"/);
    expect(cron, "test262-sharded.yml must declare a cron schedule").not.toBeNull();
    const [minute, hour, dom, month, dow] = (cron?.[1] ?? "").split(/\s+/);
    // Daily, at a fixed off-the-hour minute.
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect([dom, month, dow]).toEqual(["*", "*", "*"]);

    const promote = sharded.slice(sharded.indexOf("\n  promote-baseline:\n"));
    const condition = promote.slice(promote.indexOf("if: |"), promote.indexOf("    name:"));
    expect(condition).toContain("github.event_name == 'schedule'");
    expect(condition).toContain("needs.merge-report.result == 'success'");
  });

  it("keeps refresh-baseline.yml as a manual lever only, with no timer", () => {
    expect(refresh).toContain("workflow_dispatch:");
    expect(refresh).not.toMatch(/^\s+schedule:/m);
    expect(refresh).not.toMatch(/- cron:/);
  });

  it("backstops a daily promotion that does not land with an age-based alert", () => {
    const alert = read("baseline-floor-staleness-alert.yml");
    expect(alert).toContain("MAX_FLOOR_AGE_HOURS:");
    expect(alert).toMatch(/- cron:\s*"23 \* \* \* \*"/);
  });

  it("only alerts: nothing in the alert path dispatches a baseline refresh (owner decision 2026-11-26)", () => {
    const code = read("baseline-floor-staleness-alert.yml")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // No dispatch call (the messages may still NAME the manual lever).
    expect(code).not.toMatch(/gh workflow run|actions\/workflows\/[^"]*\/dispatches/);
    // Without actions:write it could not dispatch even if a step tried.
    expect(code).not.toMatch(/actions:\s*write/);
    // Still fails loudly on a breach.
    expect(code).toMatch(/if: steps\.staleness\.outputs\.breach == 'true'[\s\S]*?exit 1/);
  });
});
