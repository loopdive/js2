// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 cluster I, slice I3 — two standalone-only gaps, each verified RED on
// this slice's base (`584b231f`) by a file-copy A/B before the fix was written.
//
// 1. **`V instanceof Function.prototype`.** `%Function.prototype%` is a function
//    object (§20.2.3), but this backend models it as a `$NativeProto` carrier,
//    not as a closure — so `__typeof_function` answers `false` for it and
//    `__instanceof_dynamic` fell to its documented "not callable ⇒ conservative
//    false" tail. Every §7.3.20 step past IsCallable was therefore skipped: the
//    `prototype` read never happened, so a primitive `prototype` did not throw
//    and an accessor `prototype` was never invoked.
//
//    Measured on base: `[] instanceof Function.prototype` answered `false` in
//    all three shapes below (with a data-expando `prototype`, with a throwing
//    accessor `prototype`, and with no `prototype` at all), and the accessor's
//    getter ran **zero** times.
//
//    The fix is an exact `$NativeProto`-brand identity probe on that tail, NOT a
//    widening of `__typeof_function` — a wrong `true` out of that classifier is
//    observable corpus-wide.
//
// 2. **A borrowed `String.prototype.substr`.** `substr` had no reflective
//    closure body, so `String.prototype.substr.call(x)` hit the
//    borrowed-method refusal and threw a TypeError BEFORE running the
//    receiver's `toString`. Measured on base: the throwing `toString` below
//    never ran (a `TypeError` surfaced instead of the receiver's own error),
//    while the sibling `slice` propagated it correctly — which is what named
//    the defect as a missing member rather than a coercion-order bug.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // A leaked `env` import would mean the case silently ran on a JS host
  // fast-path and the answer is not the standalone substrate's.
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#6651 I3 — instanceof against %Function.prototype% (§7.3.20 steps 5-7)", () => {
  // test262 language/expressions/instanceof/primitive-prototype-with-object.js
  it("a primitive `prototype` throws TypeError [base: 3 = silent false]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        (Function.prototype as any).prototype = "";
        try { const b: any = ([] as any) instanceof (Function.prototype as any); return b ? 2 : 3; }
        catch (e) { return 1; }
      }`),
    ).toBe(1);
  });

  // test262 language/expressions/instanceof/prototype-getter-with-object-throws.js
  it("an accessor `prototype` is INVOKED, exactly once, and its throw propagates [base: 103]", async () => {
    expect(
      await runStandalone(`let n = 0;
        export function run(): number {
          Object.defineProperty(Function.prototype as any, "prototype", {
            get: function () { n = n + 1; throw new RangeError("dummy"); },
          });
          try { const b: any = ([] as any) instanceof (Function.prototype as any); return 100 + (b ? 2 : 3); }
          catch (e) { return n * 10 + 1; }
        }`),
    ).toBe(11);
  });

  it("an ABSENT `prototype` is undefined ⇒ step-6 TypeError [base: 3 = silent false]", async () => {
    expect(
      await runStandalone(`export function run(): number {
        try { const b: any = ([] as any) instanceof (Function.prototype as any); return b ? 2 : 3; }
        catch (e) { return 1; }
      }`),
    ).toBe(1);
  });

  it("§7.3.20 step 3 still precedes the read: a primitive V is false, never a throw", async () => {
    expect(
      await runStandalone(`export function run(): number {
        (Function.prototype as any).prototype = "";
        try { const b: any = (5 as any) instanceof (Function.prototype as any); return b ? 2 : 3; }
        catch (e) { return 1; }
      }`),
    ).toBe(3);
  });

  // Regression locks: the ordinary paths this arm must not disturb. All four
  // answer the same on base and after — the arm is reached only on the
  // not-callable tail, for one exact carrier.
  it("control — `{} instanceof Object` unchanged", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = {}; const b: any = o instanceof Object; return b ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
  it("control — `fn instanceof Function` unchanged", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const f: any = function () {}; const b: any = f instanceof Function; return b ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
  it("control — `[] instanceof Array` unchanged", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: any = []; const b: any = a instanceof Array; return b ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
  it("control — a NON-Function `$NativeProto` RHS (`Array.prototype`) is untouched", async () => {
    expect(
      await runStandalone(`export function run(): number {
        try { const b: any = ([] as any) instanceof (Array.prototype as any); return b ? 2 : 3; }
        catch (e) { return 1; }
      }`),
    ).toBe(3);
  });
});

describe("#6651 I3 — a borrowed `String.prototype.substr` (Annex B B.2.2.1)", () => {
  const BORROW = `const f: any = (String.prototype as any).substr;`;

  // test262 annexB/built-ins/String/prototype/substr/this-to-str-err.js
  it("ToString(this) runs and its throw propagates [base: 2 = a TypeError instead]", async () => {
    expect(
      await runStandalone(`export function run(): number { ${BORROW}
        const t: any = { toString: function () { throw new RangeError("mine"); } };
        try { f.call(t); return 0; } catch (e) { return (e instanceof RangeError) ? 1 : 2; }
      }`),
    ).toBe(1);
  });

  it("RequireObjectCoercible still throws TypeError for null", async () => {
    expect(
      await runStandalone(`export function run(): number { ${BORROW}
        try { f.call(null); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; }
      }`),
    ).toBe(1);
  });

  // B.2.2.1 semantics, borrowed. The second bound is a LENGTH, not an end
  // index; the absent-bound sentinel the shared body already uses is still
  // correct because the helper's min(length, tail) turns it into "to the end".
  it.each([
    ["f.call('abcdef', 1, 3) === 'bcd'", `f.call("abcdef", 1, 3)`, `"bcd"`],
    ["negative start counts from the end", `f.call("abcdef", -2)`, `"ef"`],
    ["an absent length runs to the end", `f.call("abcdef", 2)`, `"cdef"`],
    ["a negative length is the empty string", `f.call("abcdef", 1, -1)`, `""`],
    ["a start past the end is the empty string", `f.call("abcdef", 99)`, `""`],
    ["a non-string receiver is ToString'd", `f.call(12345 as any, 1, 2)`, `"23"`],
  ])("%s", async (_name, expr, want) => {
    expect(
      await runStandalone(
        `export function run(): number { ${BORROW} const v: any = ${expr}; return v === ${want} ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  // The DIRECT call path (string-ops.ts) is a different lowering and must not
  // move; these answer 1 on base too.
  it.each([
    ["direct literal substr(1, 3)", `"abcdef".substr(1, 3)`, `"bcd"`],
    ["direct literal substr(-2)", `"abcdef".substr(-2)`, `"ef"`],
  ])("control — %s unchanged", async (_name, expr, want) => {
    expect(
      await runStandalone(`export function run(): number { const v: any = ${expr}; return v === ${want} ? 1 : 0; }`),
    ).toBe(1);
  });

  it("control — a dynamic receiver's direct `.substr` is unchanged", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const s: any = "abcdef"; const v: any = s.substr(1); return v === "bcdef" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
