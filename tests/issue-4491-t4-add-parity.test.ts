// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4491 T4 parity — `f + x` and `f.toString() + x` must answer the same string.
 *
 * §20.2.3.5 step 1: a function's ToPrimitive answer is its `[[SourceText]]`.
 * `f.toString()` has served that from `ctx.funcSourceText` since #1463; the `+`
 * operand path reached only the runtime `__extern_toString`, whose callable
 * terminal is step 3's `"function () { [native code] }"` placeholder. Measured
 * on `340f7c49d`, standalone:
 *
 * ```
 * f1 + 1            -> "function () { [native code] }1"
 * f1.toString() + 1 -> "function f1() { return 0; }1"
 * ```
 *
 * which is `language/expressions/addition/S11.6.1_A2.2_T3` CHECK#1. Reported by
 * dev-4515, who left the fix to this lane rather than patch another's module.
 *
 * ## Where the fix is NOT
 *
 * The obvious suspect — `add-to-primitive.ts`'s `fctx.localMap.has(expr.text)`
 * guard, which always fires under the test262 harness because its synthetic
 * `export function test()` wrapper makes every top-level function a local — is
 * real but was NOT sufficient: **repairing it alone moved 0 of 128 rows**, because
 * for this operand shape the helper is never called at all. `emitObjectAdd`
 * (`addition-to-primitive.ts`, #4564) claims `f1 + 1` at an EARLIER dispatch in
 * `binary-ops.ts`, so the later `admitsObjectAdd` arm that owns the helper is
 * unreachable. The fix is both: make the guard precise (an oracle question, not
 * a name-in-a-map question) AND consult the helper from the live path.
 *
 * The three "must not fold" pins below are the reason the guards exist — they
 * are CHECKS #2-#4 of the same test262 row, and they were the shapes the fold
 * silently won before the override guard was written.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  expect(WebAssembly.validate(result.binary!), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { main: () => unknown }).main();
}

describe("#4491 T4 — `+` and `.toString()` agree on a function's source text", () => {
  // Both spellings are EXECUTED and compared to each other, and the result is
  // also checked to be the real source text rather than the placeholder — so a
  // regression that made BOTH answer the placeholder could not pass this.
  it("f1 + 1 === f1.toString() + 1, and both carry the declaration text", async () => {
    expect(
      await runStandalone(`
        function f1() { return 0; }
        export function main() {
          var viaPlus = f1 + 1;
          var viaToString = f1.toString() + 1;
          var agree = (viaPlus === viaToString);
          var isSourceText = (viaPlus.indexOf("return 0") >= 0);
          var notPlaceholder = (viaPlus.indexOf("native code") < 0);
          return (agree && isSourceText && notPlaceholder) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // CHECK#2 of the row: a `valueOf` override moves the ToPrimitive answer off
  // the source text entirely. The fold MUST decline here — this is the shape
  // the override guard exists for, and it must keep declining now that the
  // helper is reachable from a second call site.
  it("declines when the function has a valueOf override", async () => {
    expect(
      await runStandalone(`
        function f2() { return 0; }
        f2.valueOf = function () { return 1; };
        export function main() {
          return ((1 + f2) === 2) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // CHECK#3: a `toString` override, same requirement.
  it("declines when the function has a toString override", async () => {
    expect(
      await runStandalone(`
        function f3() { return 0; }
        f3.toString = function () { return 1; };
        export function main() {
          return ((1 + f3) === 2) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // CHECK#4: both overrides — `valueOf` wins for the default hint, so the
  // answer is numeric and negative.
  it("declines when the function has both overrides", async () => {
    expect(
      await runStandalone(`
        function f4() { return 0; }
        f4.valueOf = function () { return -1; };
        f4.toString = function () { return 1; };
        export function main() {
          return ((f4 + 1) === 0) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // The #3364 shadowing hazard the replaced guard cited. It is still refused —
  // the resolved declaration is a `var`, not the `FunctionDeclaration` — and
  // this pin is what proves the guard was made PRECISE rather than removed.
  // Passes on both arms by construction (the old guard refused every local);
  // it is here as a control that must not move.
  it("does not fold a LOCAL that shadows a top-level function's name", async () => {
    expect(
      await runStandalone(`
        function g() { return 0; }
        function shadowed() {
          var g = 5;
          return g + 1;
        }
        export function main() {
          return (shadowed() === 6) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
