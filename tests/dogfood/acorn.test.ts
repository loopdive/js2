// Thin vitest wrapper around the acorn dogfood harness (#1710).
//
// This asserts the HARNESS contract, not acorn conformance:
//   - the harness runs to completion and emits a structured report even when
//     the compiled-acorn surface is red (acceptance #3),
//   - the reusable differential-AST function (reused by #1712) actually detects
//     both equality and divergence (oracle self-check),
//   - the pinned-tarball integrity gate holds.
//
// Acorn FULLY parsing correctly is the #1712 acceptance gate, deliberately NOT
// asserted here — a red surface is an expected, recorded outcome.

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDogfoodScript } from "./run-dogfood-script";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { diffAst } from "./ast-diff.mjs";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { setupAcorn } from "./setup-acorn.mjs";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { buildTestVariants, parseTest262Flags } from "./acorn-test262.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("acorn dogfood harness (#1710)", () => {
  it("acquires the pinned acorn tarball and passes the integrity gate", () => {
    const { version, pin } = setupAcorn();
    expect(version).toBe("8.16.0");
    expect(pin.shasum).toMatch(/^[0-9a-f]{40}$/);
  });

  // The full loop compiles the ~230 KB acorn entry module (~27s, ~780 KB
  // binary). Running that synchronous compile *inside* the vitest worker blocks
  // the event loop long enough to trip the RPC heartbeat ("Timeout calling
  // onTaskUpdate") and fail the run with an exit code even though assertions
  // pass. So we run the harness as a CHILD PROCESS (its canonical `--json`
  // entrypoint) and assert on the emitted report — the compile never touches
  // the vitest worker thread.
  //
  // It is also opt-in (`DOGFOOD_ACORN=1`): a 27s compile has no place in the
  // default per-PR sweep. The canonical entrypoint is `pnpm run dogfood:acorn`.
  // The lightweight diffAst + integrity assertions below DO run every sweep and
  // cover the reusable #1712 gate.
  const heavy = process.env.DOGFOOD_ACORN === "1" ? it : it.skip;
  heavy(
    "runs the compile→validate→diff loop to completion and emits a structured report",
    { timeout: 180_000 },
    async () => {
      const out = await runDogfoodScript(join(HERE, "acorn-harness.mjs"), ["--json"]);
      const report = JSON.parse(out);

      // Structured surface report shape (acceptance #2)
      expect(report.acorn?.version).toBe("8.16.0");
      expect(report.compile).toBeTruthy();
      expect(report.validation).toBeTruthy();
      expect(report.summary?.headline).toBeTypeOf("string");

      // Robust to a red surface (acceptance #3): even if the binary is invalid,
      // the harness must have produced compile + validation records, not crashed.
      expect(typeof report.validation.validates).toBe("boolean");
      if (!report.validation.validates) {
        expect(report.validation.firstError).toBeTypeOf("string");
        // run+diff is recorded as skipped, not crashed
        expect(report.diff.runnable).toBe(false);
        expect(report.diff.skippedReason).toBeTypeOf("string");
      }

      // The differential-AST gate must be proven usable for #1712 regardless of
      // whether compiled-acorn can run yet.
      expect(report.diff.oracleSelfCheck?.passed).toBe(true);
    },
  );

  it("diffAst detects equality and reports the first divergence with a path (the #1712 gate)", () => {
    const equal = diffAst({ type: "X", a: 1, start: 0, end: 2 }, { type: "X", a: 1, start: 5, end: 9 });
    expect(equal.equal).toBe(true); // positions ignored by default

    const diff = diffAst(
      { type: "BinaryExpression", operator: "+" },
      { type: "BinaryExpression", operator: "-" },
      { maxDivergences: 1 },
    );
    expect(diff.equal).toBe(false);
    expect(diff.divergences[0].path).toBe("$.operator");
    expect(diff.divergences[0].reason).toBe("primitive-mismatch");
  });

  it("builds Test262 parser variants from inline and block metadata flags", () => {
    const moduleSource = "/*---\nflags: [module, async]\n---*/\nexport default 1;";
    expect(parseTest262Flags(moduleSource)).toEqual(["module", "async"]);
    expect(buildTestVariants(moduleSource, parseTest262Flags(moduleSource))).toMatchObject([
      { mode: "module", options: { ecmaVersion: 2025, sourceType: "module" } },
    ]);

    const defaultSource = "/*---\nflags:\n  - generated\n---*/\nlet x = 1;";
    expect(parseTest262Flags(defaultSource)).toEqual(["generated"]);
    expect(buildTestVariants(defaultSource, parseTest262Flags(defaultSource)).map((variant) => variant.mode)).toEqual([
      "sloppy",
      "strict",
    ]);

    const noStrictSource = "/*---\nflags: [noStrict]\n---*/\nwith ({}) {}";
    expect(buildTestVariants(noStrictSource, parseTest262Flags(noStrictSource)).map((variant) => variant.mode)).toEqual(
      ["sloppy"],
    );
  });
});
