// Thin vitest wrapper around the clsx dogfood harness (#3748).
//
// This asserts the HARNESS contract, plus a real regression floor on the
// op-diff (unlike acorn.test.ts/marked.test.ts, which only assert the
// harness ran to completion): clsx is small and fast enough (~1s compile)
// that a real per-op pass count is cheap to gate on every run, and the
// current 17/18 is precise and known (the 18th, `op_array_of_objects`, is
// #3749 — filed, not fixed here; a regression below 17 means something NEW
// broke).

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDogfoodScript } from "./run-dogfood-script";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { setupClsx } from "./setup-clsx.mjs";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { CLSX_OPS } from "./clsx-ops.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const BASELINE_EQUAL = 17;
const BASELINE_TOTAL = 18;

describe("clsx dogfood harness (#3748)", () => {
  it("acquires the pinned clsx tarball and passes the integrity gate", () => {
    const { version, pin } = setupClsx();
    expect(version).toBe("2.1.1");
    expect(pin.shasum).toMatch(/^[0-9a-f]{40}$/);
  });

  it("op list matches the known baseline count", () => {
    expect(CLSX_OPS.length).toBe(BASELINE_TOTAL);
  });

  // Same rationale as acorn.test.ts/marked.test.ts: run as a CHILD PROCESS so
  // a synchronous compile never blocks the vitest worker's event loop / RPC
  // heartbeat. Opt-in (DOGFOOD_CLSX=1) — the canonical entrypoint is
  // `pnpm run dogfood:clsx`.
  const heavy = process.env.DOGFOOD_CLSX === "1" ? it : it.skip;
  heavy(
    "runs the compile→validate→diff loop and matches the known 17/18 op-diff floor",
    { timeout: 60_000 },
    async () => {
      const out = await runDogfoodScript(join(HERE, "clsx-harness.mjs"), ["--json"]);
      const report = JSON.parse(out);

      expect(report.clsx?.version).toBe("2.1.1");
      expect(report.compile).toBeTruthy();
      expect(report.validation).toBeTruthy();
      expect(report.compile.success).toBe(true);
      expect(report.validation.validates).toBe(true);
      expect(report.diff.runnable).toBe(true);

      // Regression floor: known-red op (#3749) aside, every other op must
      // match native clsx. A drop below BASELINE_EQUAL means something NEW
      // diverged; raise the floor only after a genuine fix, never to paper
      // over a fresh regression.
      const equal = report.diff.ops.filter((o: { status: string }) => o.status === "equal").length;
      expect(equal).toBeGreaterThanOrEqual(BASELINE_EQUAL);
      expect(report.diff.ops.length).toBe(BASELINE_TOTAL);

      // #3749 pin: still exactly the one known-red op, still failing the same
      // way. If this starts passing, #3749 got fixed — go raise the floor and
      // close it out, don't just silently swallow the improvement here.
      const knownRed = report.diff.ops.find((o: { op: string }) => o.op === "op_array_of_objects");
      expect(knownRed?.status).toBe("compiled-threw");
    },
  );
});
