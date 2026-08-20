// Thin vitest wrapper around the marked dogfood harness (#3716).
//
// This asserts the HARNESS contract, not marked conformance:
//   - the harness runs to completion and emits a structured report even when
//     the compiled surface is red (mirrors acorn's #1710 acceptance bar),
//   - the pinned-tarball integrity gate holds.
//
// marked FULLY compiling/rendering correctly is NOT asserted here — the
// current surface is red (#3715, evolving-array-type inference), and a red
// surface is an expected, recorded outcome, same as acorn's early history.

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDogfoodScript } from "./run-dogfood-script";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { setupMarked } from "./setup-marked.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("marked dogfood harness (#3716)", () => {
  it("acquires the pinned marked tarball and passes the integrity gate", () => {
    const { version, pin } = setupMarked();
    expect(version).toBe("18.0.2");
    expect(pin.shasum).toMatch(/^[0-9a-f]{40}$/);
  });

  // Same reasoning as acorn.test.ts: run the compile→validate→diff loop as a
  // CHILD PROCESS so a slow synchronous compile never blocks the vitest
  // worker's event loop / RPC heartbeat. Opt-in (DOGFOOD_MARKED=1) — the
  // canonical entrypoint is `pnpm run dogfood:marked`.
  const heavy = process.env.DOGFOOD_MARKED === "1" ? it : it.skip;
  heavy(
    "runs the compile→validate→diff loop to completion and emits a structured report",
    { timeout: 60_000 },
    async () => {
      const out = await runDogfoodScript(join(HERE, "marked-harness.mjs"), ["--json"]);
      const report = JSON.parse(out);

      expect(report.marked?.version).toBe("18.0.2");
      expect(report.compile).toBeTruthy();
      expect(report.validation).toBeTruthy();
      expect(report.summary?.headline).toBeTypeOf("string");

      // Robust to a red surface: even if compile fails outright, the harness
      // must have produced a compile record, not crashed.
      expect(typeof report.compile.success).toBe("boolean");
      if (!report.compile.success) {
        expect(report.diff.runnable).toBe(false);
        expect(report.diff.skippedReason).toBeTypeOf("string");
      }
    },
  );
});
