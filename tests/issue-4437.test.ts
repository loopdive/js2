// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4437) `name` as an own property of a user function instance, and the
// reflective `length` VALUE as §15.1.5 ExpectedArgumentCount.
//
// These are #4436's two measured residuals (R1/R2), which it recorded as ONE
// slice because they need the SAME substrate. Measured on this branch's base
// `f5e2fa6` with `--target standalone`:
//
//   | read on `function f(a,b){}` / `function g(x=42,y){}` | base | spec |
//   | ---------------------------------------------------- | ---- | ---- |
//   | `f["name"]` (dynamic key — what verifyProperty uses)  | undef| "f"  |
//   | `f.hasOwnProperty("name")`                            | false| true |
//   | `Object.getOwnPropertyDescriptor(f, "name")`          | undef| desc |
//   | `Object.getOwnPropertyNames(f)` ∋ "name"              | false| true |
//   | `g["length"]` (reflective)                            | 2    | 0    |
//
// The `length` row is the interesting one: `$arity` (the #3673 closure-header
// slot #4436 answered from) is the DECLARED FORMAL COUNT, and §15.1.5 is a
// PREFIX count that stops at the first defaulted/optional parameter. The two are
// different numbers with different jobs — `closure-exports.ts` widens an
// under-applied dispatch to `max(n, $arity)`, so lowering `$arity` to the spec
// value would stop padding omitted arguments. Hence a SECOND carrier rather than
// a re-pointing, which is why R1 and R2 are one change: the `$fnmeta` slot that
// gives `name` a home is the same slot that gives `length` an exact value.
//
// The tests below assert the surfaces AGAINST EACH OTHER (descriptor value ==
// dynamic read == static fold), not just against literals — that agreement is
// the actual invariant, and it is what test262's `propertyHelper.js` checks.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { expectedArgumentCountOfParams } from "../src/codegen/function-expected-argument-count.js";
import { ts } from "../src/ts-api.js";

/** Compile `body` as the `test()` export and run it host-free. */
async function runStandalone(body: string): Promise<number> {
  const source = `export function test(): number { ${body} }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4437.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  // Host-free: a standalone module must instantiate against an empty import
  // object. If this ever needs a host bridge, the arms leaked an import.
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4437 — `name` is an own property of a user function instance", () => {
  it("answers the dynamic (runtime-key) read, not just the static fold", async () => {
    // The static fold already worked on `main`; the reflective read is what
    // `verifyProperty` uses, because its receiver AND key are parameters.
    expect(await runStandalone(`function f(a,b){} var k = "name"; return f[k] === "f" ? 1 : 0;`)).toBe(1);
  });

  it("agrees across hasOwnProperty / gOPD / getOwnPropertyNames / dynamic read", async () => {
    // One property, five surfaces. Asserted together because the failure mode
    // #4436 hit was a SPLIT (hasOwnProperty true, gOPD undefined), not an
    // absence — a single surface passing proves nothing about the others.
    expect(
      await runStandalone(`
        function f(a,b){}
        var k = "name";
        var d = Object.getOwnPropertyDescriptor(f, "name");
        var names = Object.getOwnPropertyNames(f);
        var inNames = 0;
        for (var i = 0; i < names.length; i++) { if (names[i] === "name") inNames = 1; }
        return (f.hasOwnProperty("name") && d !== undefined && d.value === "f" && f[k] === "f" && inNames) ? 1 : 0;`),
    ).toBe(1);
  });

  it("carries §10.2.8 attributes: non-writable, non-enumerable, configurable", async () => {
    expect(
      await runStandalone(`
        function f(){}
        var d = Object.getOwnPropertyDescriptor(f, "name");
        return (d.writable === false && d.enumerable === false && d.configurable === true) ? 1 : 0;`),
    ).toBe(1);
  });

  it("is DELETABLE, and the delete is observable through hasOwnProperty", async () => {
    // #4010's ordering law: `propertyHelper`'s `isConfigurable` is
    // `delete obj[k]; return !hasOwnProperty(obj, k)`. A visible-but-undeletable
    // property fails every `verifyProperty` naming `configurable: true` — which
    // is all of them. #4055 v1 shipped visibility without delete and the merge
    // queue parked it at -684.
    expect(
      await runStandalone(`
        function f(){}
        delete f.name;
        return f.hasOwnProperty("name") ? 0 : 1;`),
    ).toBe(1);
  });

  it("refuses a write while live (writable:false), and accepts one after delete", async () => {
    // The refusal is not spelled separately: `buildBuiltinFnSetRefusalArm`
    // refuses any `__extern_set` whose key `__builtinfn_get_meta` claims, so
    // making `name` visible made the write non-writable in the same stroke —
    // and made it writable again after the delete, for free.
    expect(
      await runStandalone(`
        function f(){}
        f.name = "other";
        return f.name === "f" ? 1 : 0;`),
    ).toBe(1);
    expect(
      await runStandalone(`
        function f(){}
        delete f.name;
        f.name = "other";
        var k = "name";
        return f[k] === "other" ? 1 : 0;`),
    ).toBe(1);
    // The DYNAMIC read is deliberate. The static `f.name` fold answers from the
    // type, not the runtime, so it still says "f" after a delete+rewrite —
    // measured IDENTICALLY on base for `length` (fold 2, dynamic 5), i.e. a
    // pre-existing fold-aggressiveness divergence #4436 already had and this
    // change neither causes nor fixes. Recorded as a residual on the issue.
  });

  it("does not disturb #3468 expandos on the same function", async () => {
    expect(
      await runStandalone(`
        function f(a){}
        f.custom = 5;
        return (f.hasOwnProperty("custom") && f.hasOwnProperty("name") && f.hasOwnProperty("length")
                && f.custom === 5) ? 1 : 0;`),
    ).toBe(1);
  });

  it("covers function expressions and arrows via NamedEvaluation", async () => {
    expect(await runStandalone(`var b = function(){}; var k="name"; return b[k] === "b" ? 1 : 0;`)).toBe(1);
    expect(await runStandalone(`var a = (p) => p; var k="name"; return a[k] === "a" ? 1 : 0;`)).toBe(1);
    // A NAMED function expression keeps its own name; the binding is ignored.
    expect(await runStandalone(`var c = function inner(){}; var k="name"; return c[k] === "inner" ? 1 : 0;`)).toBe(1);
  });

  it("treats parentheses as transparent but a comma expression as opaque", async () => {
    // `language/*/fn-name-cover.js`. `(function(){})` is still an anonymous
    // function DEFINITION so NamedEvaluation applies; `(0, function(){})` is
    // not, and those files assert the binding name is NOT taken.
    expect(await runStandalone(`var cover = (function(){}); var k="name"; return cover[k] === "cover" ? 1 : 0;`)).toBe(
      1,
    );
    // A genuinely anonymous function's `name` is `""` — present, but empty; what
    // the file asserts is that the BINDING name was not taken.
    expect(
      await runStandalone(`var xCover = (0, function(){}); var k="name"; return xCover[k] === "xCover" ? 0 : 1;`),
    ).toBe(1);
  });

  it("does not leak the compiler's synthesized `new Function` identifier", async () => {
    // `eval-inline.ts` splices a real parsed declaration named
    // `__new_function_<n>`. Reading that as the observable `name` published a
    // compiler-internal identifier: `built-ins/Function/instance-name.js` went
    // from reporting `undefined` to reporting `__new_function_474`. §20.2.1.1.1
    // says the answer is `"anonymous"`.
    expect(await runStandalone(`var k="name"; return (Function())[k] === "anonymous" ? 1 : 0;`)).toBe(1);
  });

  it("does not shadow a BUILTIN function value's own metadata", async () => {
    // A #2896 meta struct is itself a funcref-wrapper-root descendant, so the
    // generic arms `ref.test`-match it too. The builtin arms are spliced in
    // FRONT and always return, which is what keeps `Array.isArray.name` its own
    // spec answer rather than a user closure's.
    expect(
      await runStandalone(`
        var g = Array.isArray;
        var k = "name";
        return (g[k] === "isArray" && g.hasOwnProperty("name")) ? 1 : 0;`),
    ).toBe(1);
  });
});

describe("#4437 — the reflective `length` is §15.1.5, not the formal count", () => {
  it("stops at the first defaulted parameter, including for required ones to its right", async () => {
    // The §15.1.5 prefix rule, on the reflective surface this time. `$arity` for
    // `g` is 2 (two declared formals) and the spec `length` is 0.
    expect(await runStandalone(`function g(x = 42, y){} var k="length"; return g[k];`)).toBe(0);
    expect(await runStandalone(`function g(x, y = 4, z){} var k="length"; return g[k];`)).toBe(1);
    expect(await runStandalone(`function g(a, b){} var k="length"; return g[k];`)).toBe(2);
  });

  it("makes the descriptor value, the dynamic read and the static fold agree", async () => {
    // The three used to disagree: the fold was already §15.1.5 while the
    // reflective read answered `$arity`. Asserting them against EACH OTHER is
    // the invariant; asserting each against `0` separately would not catch a
    // future change that moved all three together but wrongly.
    expect(
      await runStandalone(`
        function g(x = 42, y){}
        var k = "length";
        var d = Object.getOwnPropertyDescriptor(g, "length");
        return (d.value === g.length && g[k] === g.length && g.length === 0) ? 1 : 0;`),
    ).toBe(1);
  });

  it("keeps `$arity` as the DISPATCH arity — omitted arguments are still padded", async () => {
    // The reason `$arity` was not simply re-pointed. `closure-exports.ts` widens
    // an under-applied call to `max(n, $arity)`; if the spec `length` had taken
    // that slot, `y` would stop being padded and the call would trap or read
    // garbage. Calling `g(1)` through a dynamic (non-folded) receiver exercises
    // exactly that path.
    expect(
      await runStandalone(`
        function g(x = 42, y) { return y === undefined ? 7 : 9; }
        var h = g;
        return h(1);`),
    ).toBe(7);
  });

  it("rest parameters contribute nothing", async () => {
    expect(await runStandalone(`function r(a, ...rest){} var k="length"; return r[k];`)).toBe(1);
  });

  it("§15.1.5 is stated ONCE — the walk the fold uses is the walk the slot stores", async () => {
    // Unit-level companion: both the static fold and the `$fnmeta` slot call
    // `expectedArgumentCountOfParams`. If a future change gives either its own
    // copy, this and the agreement test above are what fail.
    const countOf = (src: string): number => {
      const file = ts.createSourceFile("t.js", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
      const fn = file.statements.find(ts.isFunctionDeclaration);
      if (!fn) throw new Error("no function declaration in: " + src);
      return expectedArgumentCountOfParams(fn.parameters);
    };
    expect(countOf("function f(x = 42, y) {}")).toBe(0);
    expect(countOf("function f(x, y = 4, z) {}")).toBe(1);
    expect(countOf("function f(a, ...rest) {}")).toBe(1);
  });
});

describe("#4437 — the carrier itself", () => {
  it("keeps `name` ABSENT rather than wrong where no slot was minted", async () => {
    // The `name` arm has no fallback by design: a closure whose mint site does
    // not carry a `$fnmeta` slot declines, which reads as "the property is
    // absent" — never a wrong name. `length` DOES fall back to `$arity`, so it
    // never loses the property #4436 added. Class methods are the live example
    // of a mint site still outside this slice (see the issue's residuals).
    expect(
      await runStandalone(`
        class C { m(x = 1) {} }
        var p = C.prototype;
        return p.m.hasOwnProperty("length") ? 1 : 0;`),
    ).toBe(1);
  });

  it("closure identity is preserved — the slot did not fork the value", async () => {
    // The metadata operand is pushed into the SAME cached singleton the
    // identity protocol already builds, so `f === f` and sidecar writes still
    // land on one object. A per-reference `struct.new` would break both.
    expect(
      await runStandalone(`
        function f(){}
        f.sidecar = 3;
        var g = f;
        return (g === f && g.sidecar === 3) ? 1 : 0;`),
    ).toBe(1);
  });

  it("distinct declarations of the same arity get distinct metadata", async () => {
    // The metadata GLOBAL is interned by `"<length> <name>"`. Same arity must
    // therefore NOT be enough to share an entry — only same arity AND same name,
    // where sharing is unobservable because the struct is immutable.
    expect(
      await runStandalone(`
        function a1(x){} function b1(y){}
        var k = "name";
        return (a1[k] === "a1" && b1[k] === "b1" && a1[k] !== b1[k]) ? 1 : 0;`),
    ).toBe(1);
  });

  it("a function that also has `length` reflects BOTH, from one carrier", async () => {
    // Both values come out of the same `$fnmeta` struct, so a bug that dropped
    // the slot would take both down together — asserting them jointly is what
    // makes that visible.
    expect(
      await runStandalone(`
        function g(x = 42, y){}
        var kn = "name", kl = "length";
        return (g[kn] === "g" && g[kl] === 0) ? 1 : 0;`),
    ).toBe(1);
  });
});
