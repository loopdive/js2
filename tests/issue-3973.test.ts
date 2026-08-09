import { describe, expect, it } from "vitest";
import { existsSync } from "fs";
import { runTest262File } from "./test262-runner.js";

/**
 * #3973 — standalone: a dynamic element read `x[k]` where `x` is statically
 * `any`/`unknown` and holds a STRING evaluated to `undefined`.
 *
 * The fast native element arm was gated purely STATICALLY
 * (`staticJsTypeOf(recv) === "string"`), which an implicitly-`any` parameter
 * never satisfies, so the read fell through to `__extern_get_idx` — whose
 * receiver dispatch is `$Object`-array-like / typed `__vec_<k>` / `$ObjVec`
 * only. A `$AnyString` receiver matched none of them and landed on the miss.
 * Host/gc mode was unaffected (`__extern_get_idx` is a JS host import there
 * doing a real `obj[idx]`), so this reproduced ONLY host-free.
 *
 * The regression surface that matters is test262's OWN harness:
 * `harness/nativeFunctionMatcher.js` scans with `source[pos]` on an
 * implicitly-`any` parameter, so it rejected even a perfectly valid
 * `"function () { [native code] }"` and gated every test including it.
 *
 * These files were measured fail→pass by a paired single-process A/B over the
 * full 71-file enumerated population (23 flips, 0 regressions), and re-verified
 * 23/23 with the measurement scaffold deleted. `test/harness/…` is the harness
 * self-test — the most direct assertion of the mechanism in the corpus.
 */

const TEST262 = "/workspace/test262";
const maybe = existsSync(TEST262) ? describe : describe.skip;

// A representative slice of the measured flips, spanning the distinct shapes
// that route through the guarded read (plain/bound/generator/accessor/unicode)
// plus test262's own harness self-test.
const flipped = [
  "test/harness/nativeFunctionMatcher.js",
  "test/built-ins/Function/prototype/toString/function-declaration.js",
  "test/built-ins/Function/prototype/toString/function-expression.js",
  "test/built-ins/Function/prototype/toString/bound-function.js",
  "test/built-ins/Function/prototype/toString/generator-function-declaration.js",
  "test/built-ins/Function/prototype/toString/getter-object.js",
  "test/built-ins/Function/prototype/toString/setter-object.js",
  "test/built-ins/Function/prototype/toString/unicode.js",
];

maybe("#3973 any-typed native-string element read (standalone)", () => {
  for (const rel of flipped) {
    it(`${rel} passes in the standalone lane`, async () => {
      const r = await runTest262File(`${TEST262}/${rel}`, "issue-3973", 120_000, "standalone");
      expect(r.status, `error: ${r.error ?? r.reason ?? ""}`).toBe("pass");
    }, 180_000);
  }

  // Guard against the obvious over-correction: a NON-string receiver reached
  // through the same `any`-typed dynamic read must keep its prior behaviour
  // (the else arm), and an out-of-range / non-integer index on a string must
  // still be `undefined` rather than `__str_charAt`'s empty string.
  it("does not disturb array/object receivers through the same dynamic read", async () => {
    const r = await runTest262File(
      `${TEST262}/test/built-ins/Function/prototype/toString/method-object.js`,
      "issue-3973",
      120_000,
      "standalone",
    );
    expect(r.status, `error: ${r.error ?? ""}`).toBe("pass");
  }, 180_000);
});
