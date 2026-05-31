import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

/**
 * #1669 — object-method-as-closure trampolines emitted invalid wasm after #1602.
 *
 * #1602 added `finalizeMethodTrampolines`, which rebuilds each object-method
 * trampoline body against the method's FINAL signature (param types/order are
 * re-resolved during body compilation for default-param / generator / async
 * methods). But it forwarded each param VERBATIM — `local.get i` straight into
 * `call methodFuncIdx` — with no coercion. When the trampoline's wrapper
 * (closure-value ABI) param type drifts from the method's final param type, the
 * rebuilt `call` is invalid, e.g.:
 *
 *   __obj_meth_tramp___anon_1_m_5 failed:
 *     call[0] expected type externref, found ref.cast null of type (ref null 26)
 *   __obj_meth_tramp___anon_0_method_1 failed:
 *     type error in fallthru[0] (expected externref, got (ref null 18))
 *
 * The second form is the RESULT drift (the wrapper declares an `externref`
 * result while the method now returns `(ref null N)`). This regressed ~217
 * test262 tests (91% one root cause) under `language/expressions`, the canonical
 * regressor being
 * `language/expressions/object/method-definition/name-length-dflt.js`.
 *
 * The fix re-emits the forwarding with a per-arg coercion from the wrapper param
 * type to the method param type, and a result coercion from the method result to
 * the wrapper result, so the rebuilt trampoline validates against both
 * signatures.
 *
 * Each `expect(WebAssembly.validate(...)).toBe(true)` is the regression guard:
 * before the fix these modules failed validation inside `__obj_meth_tramp_*`.
 */
async function compileValid(source: string): Promise<void> {
  const result = await compile(source, { fileName: "test.ts" });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

// The trampoline-type drift only surfaces with the test262 harness's exact
// shape — a `try/catch` around the body plus the assert-helper preamble
// re-orders/re-resolves function types AFTER the method-as-closure trampolines
// are emitted. This `wrapped(...)` reproduces that shape without the submodule.
const HARNESS_PREAMBLE = `
  class Test262Error { message: string; constructor(msg: string = "") { this.message = msg; } }
  function isSameValue(a: any, b: any): number { if (a === b) return 1; if (a !== a && b !== b) return 1; return 0; }
  let __fail = 0; let __assert_count = 1;
  function assert_sameValue(actual: any, expected: any): void {
    __assert_count = __assert_count + 1;
    if (!isSameValue(actual, expected)) { if (!__fail) __fail = __assert_count; }
  }
`;
function wrapped(body: string): string {
  return `${HARNESS_PREAMBLE}
    export function test(): number {
      try { ${body} } catch (e) { if (!__fail) __fail = -1; throw e; }
      return __fail ? __fail : 1;
    }`;
}

describe("#1669 object-method trampoline externref coercion (regressed by #1602)", () => {
  it("sibling non-generator default-param methods read as values (name-length-dflt shape)", async () => {
    // Sibling literals with default params in different positions structurally
    // dedupe; the per-call-site trampoline's wrapper param types ([externref,
    // f64]) drift from the method's final params ([f64, externref]). Before the
    // fix the rebuilt `call` failed validation:
    //   call[0] expected type externref, found ref.cast null of type (ref null N)
    // This self-contained case reproduces the regression without the submodule.
    await compileValid(
      wrapped(`
        var f1 = { m(x = 42) {} }.m;
        assert_sameValue((f1 as any).length, 0);
        var f2 = { m(x = 42, y) {} }.m;
        assert_sameValue((f2 as any).length, 0);
        var f3 = { m(x, y = 42) {} }.m;
        assert_sameValue((f3 as any).length, 1);
        var f4 = { m(x, y = 42, z) {} }.m;
        assert_sameValue((f4 as any).length, 1);
      `),
    );
  });

  // Direct compilation of the real test262 sources that regressed (param drift,
  // generator-result drift, super-prop body result drift). These compile to
  // invalid wasm on the broken compiler. Synchronous + statically imported so
  // they don't race the concurrent compile of the synthetic case above. Skips
  // gracefully when the submodule isn't checked out (CI checks it out).
  const TEST262 = join(__dirname, "..", "test262", "test");
  const regressedFiles = [
    "language/expressions/object/method-definition/name-length-dflt.js",
    "language/expressions/object/method-definition/gen-yield-identifier-spread-non-strict.js",
    "language/expressions/object/method-definition/generator-super-prop-body.js",
  ];
  for (const rel of regressedFiles) {
    const abs = join(TEST262, rel);
    it.skipIf(!existsSync(abs))(`real test262 source compiles to valid wasm: ${rel}`, async () => {
      const src = readFileSync(abs, "utf-8");
      await compileValid(wrapTest(src, parseMeta(src)).source);
    });
  }
});
