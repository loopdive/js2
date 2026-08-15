// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4436) `length` as a genuine OWN property of a user function instance, plus
// §15.1.5 ExpectedArgumentCount for the static `<fn>.length` fold.
//
// Two independent defects, both measured on `main` 2026-08-15 (standalone):
//
//   1. REFLECTION. `f.length` folded to a constant for a typed receiver, but
//      every reflective surface said the property did not exist —
//      `hasOwnProperty` false, `getOwnPropertyDescriptor` undefined,
//      `getOwnPropertyNames` without it, and the DYNAMIC `f["length"]` read
//      answering a flat `0` regardless of arity. test262's `propertyHelper.js`
//      uses exactly those surfaces (its receiver and key are runtime
//      parameters), so a correct constant fold bought nothing.
//
//   2. ARITY. The fold counted parameters with a `filter()` that removed
//      defaulted/optional/rest ones, justified by "TS forbids
//      required-after-optional". That premise does not hold for the JS this
//      compiler accepts: `function f(x = 42, y) {}` has `length === 0`, and the
//      filter answered 1. §15.1.5 is a PREFIX count that stops at the first
//      initializer, not a filter.
//
// The two are pinned together because they are one observable value: the
// descriptor's `value`, the dynamic read and the static fold must all agree,
// and the tests below assert them against each other, not just against a
// literal.
//
// DELIBERATELY NOT PINNED AS PASSING (see the issue's residual section):
// `name` is not an own property of a user closure, and the reflective `length`
// VALUE is the declared formal count rather than ExpectedArgumentCount for a
// function with a defaulted parameter. Both are asserted here in their CURRENT
// shape so the residual is visible and a future fix has to update this file
// rather than silently changing behaviour.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { expectedArgumentCountOfParams } from "../src/codegen/function-expected-argument-count.js";
import { ts } from "../src/ts-api.js";

/** Compile `body` as the `test()` export and run it host-free. */
async function runStandalone(body: string): Promise<number> {
  const source = `export function test(): number { ${body} }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4436.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  // Host-free: a standalone module must instantiate against an empty import
  // object. If this ever needs a host bridge, the arms leaked an import.
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/** §15.1.5 over a parameter list parsed from `src`'s single function. */
function expectedArgCountOf(src: string): number {
  const file = ts.createSourceFile("t.js", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const fn = file.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("no function declaration in: " + src);
  return expectedArgumentCountOfParams(fn.parameters);
}

describe("#4436 — §15.1.5 ExpectedArgumentCount", () => {
  // The rows that distinguish a PREFIX count from a FILTER. Rows 3 and 5 are
  // the ones the old `filter().length` got wrong; they are the `f2`/`f4` cases
  // of language/{statements,expressions}/function/length-dflt.js.
  it.each([
    ["function f() {}", 0],
    ["function f(x, y) {}", 2],
    ["function f(x = 42) {}", 0],
    ["function f(x = 42, y) {}", 0],
    ["function f(x, y = 42) {}", 1],
    ["function f(x, y = 42, z) {}", 1],
    ["function f(...r) {}", 0],
    ["function f(x, ...r) {}", 1],
    ["function f(x, y = 1, z = 2) {}", 1],
  ])("%s → %i", (src, want) => {
    expect(expectedArgCountOf(src)).toBe(want);
  });

  it("a defaulted parameter truncates the count for REQUIRED parameters to its right", () => {
    // The exact distinction the replaced `filter()` could not express: `y` and
    // `z` are required, and still contribute nothing.
    expect(expectedArgCountOf("function f(x = 42, y, z) {}")).toBe(0);
    expect(expectedArgCountOf("function f(a, b, c = 1, d, e) {}")).toBe(2);
  });

  it("the STATIC fold reports ExpectedArgumentCount, not the formal count", async () => {
    expect(await runStandalone(`function f(x = 42, y){} return f.length;`)).toBe(0);
    expect(await runStandalone(`function f(x, y = 42, z){} return f.length;`)).toBe(1);
    expect(await runStandalone(`function f(x, ...r){} return f.length;`)).toBe(1);
  });
});

describe("#4436 — `length` is an own property of a function instance", () => {
  it("hasOwnProperty sees it, through both spellings", async () => {
    expect(await runStandalone(`function f(a,b){} return f.hasOwnProperty("length") ? 1 : 0;`)).toBe(1);
    expect(
      await runStandalone(`function f(a,b){} return Object.prototype.hasOwnProperty.call(f,"length") ? 1 : 0;`),
    ).toBe(1);
  });

  it("getOwnPropertyDescriptor returns the §10.2.4 attribute set", async () => {
    expect(
      await runStandalone(`
        function f(a,b){}
        var d = Object.getOwnPropertyDescriptor(f, "length");
        if (d === undefined) return 90;
        if (d.value !== 2) return 91;
        if (d.writable !== false) return 92;
        if (d.enumerable !== false) return 93;
        if (d.configurable !== true) return 94;
        return 1;`),
    ).toBe(1);
  });

  it("getOwnPropertyNames includes it", async () => {
    expect(
      await runStandalone(`
        function f(a,b){}
        var n = Object.getOwnPropertyNames(f);
        for (var i = 0; i < n.length; i++) if (n[i] === "length") return 1;
        return 0;`),
    ).toBe(1);
  });

  it("the DYNAMIC read agrees with the static fold (it answered a flat 0 before)", async () => {
    // Both spellings of the same property on the same object. `verifyProperty`
    // compares exactly these two, so a disagreement is a guaranteed failure.
    expect(
      await runStandalone(`
        function f(a,b,c){}
        var k = "length";
        return (f[k] === 3 && f.length === 3) ? 1 : 0;`),
    ).toBe(1);
    expect(await runStandalone(`function f(){} var k = "length"; return f[k] === 0 ? 1 : 0;`)).toBe(1);
  });

  it("is non-writable — a write is a silent no-op, not a change", async () => {
    expect(await runStandalone(`function f(a,b){} f.length = 99; return f.length === 2 ? 1 : 0;`)).toBe(1);
    expect(await runStandalone(`function f(a,b){} f.length = 99; var k="length"; return f[k] === 2 ? 1 : 0;`)).toBe(1);
  });

  it("is configurable — delete REMOVES it (propertyHelper's isConfigurable)", async () => {
    // The #4010 ordering law: visibility without deletability fails every
    // `verifyProperty` that names `configurable: true`.
    expect(
      await runStandalone(`
        function f(a,b){}
        if (!f.hasOwnProperty("length")) return 90;
        delete f.length;
        return f.hasOwnProperty("length") ? 0 : 1;`),
    ).toBe(1);
  });

  it("a write AFTER delete resurrects it as an ordinary own property", async () => {
    // The marker-inclusive presence check: once the bag owns the key, the
    // generic `$arity` arm must stop answering or it would shadow the new value.
    expect(
      await runStandalone(`
        function f(a,b){}
        delete f.length;
        f.length = 7;
        var k = "length";
        return (f.hasOwnProperty("length") && f[k] === 7) ? 1 : 0;`),
    ).toBe(1);
  });

  it("stays NON-ENUMERABLE — for-in must not list it", async () => {
    expect(
      await runStandalone(`
        function f(a,b){}
        for (var k in f) if (k === "length") return 0;
        return 1;`),
    ).toBe(1);
  });

  it("does not disturb a builtin function's own metadata (#2896 arms win)", async () => {
    // The generic arm matches builtin meta structs too — they are
    // funcref-wrapper-root descendants. The builtin arms are spliced in FRONT
    // and always return, so `Array.isArray.length` stays its SPEC arity and is
    // never overwritten by a raw `$arity`.
    expect(
      await runStandalone(`
        var g = Array.isArray;
        var k = "length";
        return (g[k] === 1 && g.hasOwnProperty("length")) ? 1 : 0;`),
    ).toBe(1);
  });

  it("expando own properties on a function still work alongside it", async () => {
    expect(
      await runStandalone(`
        function f(a){}
        f.custom = 5;
        return (f.hasOwnProperty("custom") && f.hasOwnProperty("length") && f.custom === 5) ? 1 : 0;`),
    ).toBe(1);
  });
});

// (#4437) These two `it`s were #4436's pinned RESIDUALS — asserted in their
// then-current (wrong) shape precisely so a future fix would have to come here
// and change them rather than silently alter behaviour. #4437 is that fix: it
// gives a user closure a `$fnmeta` slot pointing at a per-declaration
// `{name, length}` struct, so both now assert the SPEC answer. The full
// assertions live in `issue-4437.test.ts`; what stays here is the exact pair
// #4436 pinned, flipped, so the residual's closure is visible from the issue
// that recorded it.
describe("#4436 residuals — closed by #4437", () => {
  it("`name` IS an own property of a user closure (was: absent)", async () => {
    expect(await runStandalone(`function f(){} return f.name === "f" ? 1 : 0;`)).toBe(1);
    expect(await runStandalone(`function f(){} return f.hasOwnProperty("name") ? 1 : 0;`)).toBe(1);
  });

  it("the reflective `length` VALUE is §15.1.5, not the formal count (was: `$arity`)", async () => {
    // The static fold was already correct; the divergence was that the runtime
    // read answered the `$arity` header slot. `$arity` still holds the DISPATCH
    // arity — closure-exports.ts pads under-applied calls to `max(n, $arity)` —
    // so the two values are carried separately rather than one re-pointed.
    expect(await runStandalone(`function f(x = 42){} return f.length;`)).toBe(0); // static
    expect(await runStandalone(`function f(x = 42){} var k="length"; return f[k];`)).toBe(0); // dynamic
  });
});
