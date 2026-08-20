// Thin vitest wrapper around the acorn OFFICIAL test suite harness (#3729).
//
// Unlike acorn.test.ts (which wraps the hand-written fixture corpus and only
// asserts "the harness runs, robust to a red surface"), this suite is
// acorn's OWN authoritative conformance check, so it's meaningful to gate on
// a pass-rate floor, not just structural completeness. The baseline
// (3507/3518, 99.7%) was established 2026-07-28; a regression below it means
// compiled acorn got LESS correct, which is worth failing CI over.

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDogfoodScript } from "./run-dogfood-script";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { setupAcorn } from "./setup-acorn.mjs";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { loadTestSuitePin } from "./setup-acorn-test-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Baseline established 2026-07-28 — do NOT lower this to make a regression
// pass. Raise it only after a genuine fix that improves the pass count
// (re-run `pnpm run dogfood:acorn-official-suite` and update both numbers).
const BASELINE_PASSED = 3507;
const BASELINE_TOTAL = 3518;

describe("acorn official test suite harness (#3729)", () => {
  it("acquires the pinned acorn tarball and test-suite pin", () => {
    const { version, pin } = setupAcorn();
    expect(version).toBe("8.16.0");
    expect(pin.shasum).toMatch(/^[0-9a-f]{40}$/);

    const suitePin = loadTestSuitePin();
    expect(suitePin.tag).toBe("8.16.0");
    expect(suitePin.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  // Same rationale as acorn.test.ts: run as a CHILD PROCESS so the ~17s
  // synchronous compile + ~4s test run never blocks the vitest worker's
  // event loop / RPC heartbeat. Opt-in (DOGFOOD_ACORN_OFFICIAL=1) AND
  // requires run-time network (git clone of acorn's test/ source, #3729 —
  // npm does not publish it) — the canonical entrypoint is
  // `pnpm run dogfood:acorn-official-suite`.
  const heavy = process.env.DOGFOOD_ACORN_OFFICIAL === "1" ? it : it.skip;
  heavy(
    "compiled acorn passes at least the established baseline of acorn's own test suite",
    { timeout: 300_000 },
    async () => {
      const out = await runDogfoodScript(join(HERE, "acorn-official-suite.mjs"), ["--json"]);
      const report = JSON.parse(out);

      expect(report.acorn?.version).toBe("8.16.0");
      expect(report.compile?.success).toBe(true);
      expect(report.results).toBeTruthy();

      // Regression gate: total case count should match the pinned suite
      // exactly (a drift here means the pin or TEST_FILES list changed,
      // which needs a deliberate baseline update, not a silent pass/fail).
      expect(report.results.total).toBe(BASELINE_TOTAL);
      expect(report.results.passed).toBeGreaterThanOrEqual(BASELINE_PASSED);
    },
  );
});
