// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4440) The METHOD half of #4437's per-function metadata carrier, and the
// descriptor-attribute enforcement reaching `new Function(…, null)`.
//
// #4437 gave a function DECLARATION / expression / arrow an exact §15.1.5
// `length` and a §10.2.9 `name`; the method mint sites take a NAME and a
// funcIdx, never a node, so class and object-literal members declined. Measured
// on this branch's base with `--target standalone` (`.tmp/run-one.mts`, the real
// `runTest262File`), before this change:
//
//   | `class C { m(x = 42) {} }` — on `C.prototype.m` | base | spec |
//   | ----------------------------------------------- | ---- | ---- |
//   | `m["length"]` (reflective)                      | 1    | 0    |
//   | `m["name"]`                                     | absent | "m" |
//
// The `1` is `$arity`, the DECLARED FORMAL COUNT #4436 answers from — right for
// dispatch (`closure-exports.ts` pads an under-applied call to `max(n,$arity)`),
// wrong for the property. All eight remaining `*length-dflt.js` files sat there.
//
// The tests below assert the surfaces AGAINST EACH OTHER (descriptor value ==
// dynamic read == typed read) wherever there is more than one, because the
// failure mode this family produces is a SPLIT, not an absence — and a split is
// exactly what test262's `propertyHelper.js` catches and a single-surface
// assertion does not.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` as the `test()` export and run it host-free. */
async function runStandalone(body: string): Promise<number> {
  const source = `export function test(): number { ${body} }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4440.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  // Host-free: a standalone module must instantiate against an empty import
  // object. If this ever needs a host bridge, the arms leaked an import.
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/**
 * Does the standalone module compiled from `body` still link the runtime-eval
 * tier? That import is the exact observable of "the `Function(…)` fold
 * declined" — a folded call is an AOT closure and needs no host at all.
 */
async function linksRuntimeEval(body: string): Promise<boolean> {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-4440.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).some(
    (imp) => imp.module === "js2wasm:runtime-eval",
  );
}

describe("#4440 — class and object-literal METHODS carry the metadata", () => {
  it("gives an instance method the §15.1.5 `length` and the §10.2.9 `name`", async () => {
    // `m(x = 42, y)` — `$arity` is 2, the §15.1.5 prefix count is 0 (the walk
    // STOPS at the first defaulted parameter, including for required ones to
    // its right).
    expect(
      await runStandalone(`
        class C { m(x = 42, y) {} }
        var k = "name", kl = "length";
        var p = C.prototype.m;
        return (p[k] === "m" && p[kl] === 0) ? 1 : 0;`),
    ).toBe(1);
  });

  it("keeps the DYNAMIC `c.m` read and the typed `C.prototype.m` read identical", async () => {
    // The two reads build the SAME cache global through INDEPENDENT lazy inits
    // (`emitCachedMethodClosureAccess` and the `member-get-dispatch` fill arm).
    // If only one pushed the `$fnmeta` operand, the answer would depend on which
    // one happened to execute first — asserting identity AND the value together
    // is what makes that visible.
    expect(
      await runStandalone(`
        class C { m(x = 42) {} }
        var c = new C();
        var t = C.prototype.m;
        var k = "length";
        return (c.m === t && c.m[k] === 0) ? 1 : 0;`),
    ).toBe(1);
  });

  it("does not collapse two classes that share a method NAME onto one entry", async () => {
    // The metadata global is interned by `"<length>:<name>"`, and the method
    // singleton is keyed by `<Class>_<method>` — both halves have to be
    // class-qualified or `C1.prototype.m` and `C2.prototype.m` would report the
    // same number. 0 and 1 here, i.e. `0*10 + 1`.
    expect(
      await runStandalone(`
        class C1 { m(x = 42, y) {} }
        class C2 { m(a, b = 1) {} }
        var k = "length";
        return C1.prototype.m[k] * 10 + C2.prototype.m[k];`),
    ).toBe(1);
  });

  it("covers STATIC methods, which reach a different mint site", async () => {
    // `C.m` is read through `emitFuncRefAsClosure`, not the cached method
    // singleton — a separate wiring that the `*static-method-length-dflt.js`
    // files exercise and the instance-method one does not.
    expect(
      await runStandalone(`
        class C { static s(p = 1, q) {} }
        var k = "name", kl = "length";
        return (C.s[k] === "s" && C.s[kl] === 0) ? 1 : 0;`),
    ).toBe(1);
  });

  it("covers object-literal methods", async () => {
    expect(
      await runStandalone(`
        var o = { m(x = 42, y) {} };
        var k = "name", kl = "length";
        return (o.m[k] === "m" && o.m[kl] === 0) ? 1 : 0;`),
    ).toBe(1);
  });

  it("applies §10.2.9's `get `/`set ` prefix to accessor functions", async () => {
    // The prefix is part of the spec answer, not decoration, and it is the
    // reason a method's `name` cannot come from `fnMetaSlot`'s declaration walk:
    // it is derived from the property KEY plus the accessor kind.
    expect(
      await runStandalone(`
        var o = { set m(x = 42) {} };
        var s = Object.getOwnPropertyDescriptor(o, "m").set;
        var k = "name", kl = "length";
        return (s[k] === "set m" && s[kl] === 0) ? 1 : 0;`),
    ).toBe(1);
    expect(
      await runStandalone(`
        var o = { get p() { return 1; } };
        var g = Object.getOwnPropertyDescriptor(o, "p").get;
        var k = "name", kl = "length";
        return (g[k] === "get p" && g[kl] === 0) ? 1 : 0;`),
    ).toBe(1);
  });

  it("DECLINES a computed/symbol key rather than publishing a guess", async () => {
    // §10.2.9 for `[Symbol.iterator]() {}` is `"[Symbol.iterator]"`, which this
    // slice does not resolve. Declining leaves `name` ABSENT — the pre-#4440
    // state — where guessing would publish a WRONG name. That asymmetry is
    // #4437's design and the reason the remaining residuals are safe to leave.
    expect(
      await runStandalone(`
        class C { [Symbol.iterator]() {} }
        var p = C.prototype[Symbol.iterator];
        var k = "name";
        return p[k] === undefined ? 1 : 0;`),
    ).toBe(1);
  });
});

describe("#4440 — a method's `length` carries the §10.2.4 attributes", () => {
  it("reports {writable:false, enumerable:false, configurable:true} with the right value", async () => {
    expect(
      await runStandalone(`
        class C { m(x = 42) {} }
        var d = Object.getOwnPropertyDescriptor(C.prototype.m, "length");
        return (d.value === 0 && d.writable === false && d.enumerable === false && d.configurable === true) ? 1 : 0;`),
    ).toBe(1);
  });

  it("is deletable (configurable:true) and refuses a write while live", async () => {
    // #4010's ordering law: `propertyHelper`'s `isConfigurable` is
    // `delete obj[k]; return !hasOwnProperty(obj, k)`, so a visible-but-
    // undeletable property fails every `verifyProperty` naming
    // `configurable: true` — which is every one of the target files.
    expect(
      await runStandalone(`
        class C { m(x = 42) {} }
        var p = C.prototype.m;
        delete p.length;
        return p.hasOwnProperty("length") ? 0 : 1;`),
    ).toBe(1);
    expect(
      await runStandalone(`
        class C { m(x = 42) {} }
        var p = C.prototype.m;
        p.length = 9;
        var k = "length";
        return p[k];`),
    ).toBe(0);
  });
});

describe("#4440 — `new Function` with a non-string argument", () => {
  it("treats a `null` body as the constant body it is, not a dynamic one", async () => {
    // §20.2.1.1.1 `ToString`s every argument, so `new Function("a,b,c", null)`
    // is `function anonymous(a,b,c) { null }`. Declining sent it to the
    // runtime-eval tier, whose function object is not a Wasm closure and so
    // carries no `$bag`, no `$fnmeta` and none of the reflective arms —
    // measured on base through an opaque receiver: `getOwnPropertyNames` 0
    // (vs 2), `delete x.length` a no-op, `x.length = 99` accepted.
    //
    // 11 = `length` (1) + `name` (10), i.e. BOTH own properties are enumerated.
    expect(
      await runStandalone(`
        var f = new Function("a,b,c", null);
        var n = Object.getOwnPropertyNames(f);
        var s = 0;
        for (var i = 0; i < n.length; i++) { if (n[i] === "length") s += 1; if (n[i] === "name") s += 10; }
        return s;`),
    ).toBe(11);
  });

  it("makes DontDelete and ReadOnly reach it (S15.3.5.1_A2 / _A3)", async () => {
    expect(
      await runStandalone(`
        var f = new Function("arg1,arg2,arg3", null);
        var deleted = delete f.length;
        return (deleted && !f.hasOwnProperty("length")) ? 1 : 0;`),
    ).toBe(1);
    expect(
      await runStandalone(`
        var f = new Function("arg1,arg2,arg3", "arg4,arg5", null);
        f.length = 99;
        var k = "length";
        return f[k];`),
    ).toBe(5);
  });

  it("R6 LANDED (#4442): `f.constructor` is `%Function%`, not `undefined`", async () => {
    // This pin used to assert `g.constructor === undefined`, with the note that
    // it "flips to `=== Function` when the `%Function%` carrier lands (see R6)".
    // #4442 landed it, so this is that flip — kept as a pin in THIS file so the
    // fold's cost cannot silently come back.
    //
    // It asserts the carrier's SHAPE rather than `=== Function` because
    // `runStandalone` instantiates against an EMPTY import object: writing the
    // bare `Function` identifier here would make the module provider-linked
    // (an `intrinsic-value` boundary site) and it would no longer be host-free.
    // That is not a workaround — it is the whole point of #4442's split, and
    // the `=== Function` identity is pinned in `tests/issue-4442.test.ts`,
    // which runs the linked kind through the real provider seam.
    expect(
      await runStandalone(`
        function g(a, b) {}
        var c = g.constructor;
        return (c !== undefined && c.name === "Function" && c.length === 1) ? 1 : 0;`),
    ).toBe(1);
  });

  it("folds the other two KEYWORD literals", async () => {
    // `true`/`false` are keyword TOKENS: their ToString is fixed by the grammar
    // and unshadowable, so `new Function("a", true)` is
    // `function anonymous(a) { true }` — arity 1.
    expect(await runStandalone(`var f = new Function("a", true); var k = "length"; return f[k];`)).toBe(1);
  });

  it("still DECLINES anything whose ToString is not fixed by the grammar", async () => {
    // `undefined` is an ordinary, shadowable identifier; a numeric literal's
    // ToString is Number::toString (`1e21` → `"1e+21"`, `0x10` → `"16"`).
    // Publishing a wrong function BODY is far worse than declining to fold, so
    // both keep routing to the runtime-eval tier.
    //
    // Asserted through the IMPORT SECTION rather than by running the module:
    // "did the fold fire?" IS "is `js2wasm:runtime-eval` linked?", and a
    // declined fold cannot instantiate host-free at all — which is the whole
    // reason the six `Function/length` files were unreachable.
    expect(await linksRuntimeEval(`var f = new Function("a", 1e21); return 0;`)).toBe(true);
    expect(await linksRuntimeEval(`var f = new Function("a", undefined); return 0;`)).toBe(true);
    // …while the three keyword literals do not need it.
    expect(await linksRuntimeEval(`var f = new Function("a", null); return 0;`)).toBe(false);
    expect(await linksRuntimeEval(`var f = new Function("a", false); return 0;`)).toBe(false);
  });
});
