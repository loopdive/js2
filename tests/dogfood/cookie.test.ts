// Thin vitest wrapper around the cookie dogfood harness (#3751).
//
// This asserts the HARNESS contract, plus a real regression floor on the
// op-diff (same rationale as clsx.test.ts): cookie is small and fast enough
// (~2s compile) that a real per-op pass count is cheap to gate on every run,
// and the current 18/21 is precise and known (the 3 red ops are #3750 — a
// regression below 18 means something NEW broke, beyond the known bug).

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDogfoodScript } from "./run-dogfood-script";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { setupCookie } from "./setup-cookie.mjs";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { COOKIE_OPS } from "./cookie-ops.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const BASELINE_EQUAL = 18;
const BASELINE_TOTAL = 21;
const KNOWN_RED_OPS = ["parseSetCookie_httponly", "parseSetCookie_path", "parseSetCookie_multiple_attrs"];

describe("cookie dogfood harness (#3751)", () => {
  it("acquires the pinned cookie tarball and passes the integrity gate", () => {
    const { version, pin } = setupCookie();
    expect(version).toBe("2.0.1");
    expect(pin.shasum).toMatch(/^[0-9a-f]{40}$/);
  });

  it("op list matches the known baseline count", () => {
    expect(COOKIE_OPS.length).toBe(BASELINE_TOTAL);
  });

  // Same rationale as acorn.test.ts/marked.test.ts/clsx.test.ts: run as a
  // CHILD PROCESS so a synchronous compile never blocks the vitest worker's
  // event loop / RPC heartbeat. Opt-in (DOGFOOD_COOKIE=1) — the canonical
  // entrypoint is `pnpm run dogfood:cookie`.
  const heavy = process.env.DOGFOOD_COOKIE === "1" ? it : it.skip;
  heavy(
    "runs the compile→validate→diff loop and matches the known 18/21 op-diff floor",
    { timeout: 60_000 },
    async () => {
      const out = await runDogfoodScript(join(HERE, "cookie-harness.mjs"), ["--json"]);
      const report = JSON.parse(out);

      expect(report.cookie?.version).toBe("2.0.1");
      expect(report.compile).toBeTruthy();
      expect(report.validation).toBeTruthy();
      expect(report.compile.success).toBe(true);
      expect(report.validation.validates).toBe(true);
      expect(report.diff.runnable).toBe(true);

      // Regression floor: known-red ops (#3750) aside, every other op must
      // match native cookie. A drop below BASELINE_EQUAL means something NEW
      // diverged; raise the floor only after a genuine fix, never to paper
      // over a fresh regression.
      const equal = report.diff.ops.filter((o: { status: string }) => o.status === "equal").length;
      expect(equal).toBeGreaterThanOrEqual(BASELINE_EQUAL);
      expect(report.diff.ops.length).toBe(BASELINE_TOTAL);

      // #3750 pin: still exactly the three known-red ops, still failing the
      // same way. If any of these start passing, #3750 got (at least
      // partially) fixed — go raise the floor and update the issue, don't
      // just silently swallow the improvement here.
      for (const opName of KNOWN_RED_OPS) {
        const knownRed = report.diff.ops.find((o: { op: string }) => o.op === opName);
        expect(knownRed?.status).toBe("divergent");
      }
    },
  );
});
