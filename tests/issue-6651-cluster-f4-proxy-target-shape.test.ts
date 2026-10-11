// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster F, slice F4) A proxy read/written through the TARGET's static
 * shape, and a proxy returned by a helper.
 *
 * TypeScript types `new Proxy(t, h)` as `typeof t` — its lib signature is
 * `new <T extends object>(target: T, handler: ProxyHandler<T>): T`. So a proxy
 * over an array is statically `number[]` and a proxy over `new String("str")`
 * is statically `String`, and every codegen arm that keys off that static type
 * lowered a read/write of the TARGET's native representation against a
 * `$Proxy` struct, which has none of those fields.
 *
 * Measured on this branch's base (`86943b93`), standalone:
 *
 * | program                                     | base           | node |
 * | ------------------------------------------- | -------------- | ---- |
 * | `new Proxy([1,2,3],{}).length`              | `0`            | `3`  |
 * | `new Proxy([1,2,3],{})[0]`                  | `NaN`          | `1`  |
 * | `new Proxy(new String("str"),{}).length`    | **wasm trap**  | `3`  |
 * | `p.length = 0` on a proxy over `[1,2,3]`    | array untouched| `[]` |
 * | …with a `set` trap installed                | 0 trap calls   | 1    |
 *
 * The third row is the worst of them: "dereferencing a null pointer" is a hard
 * trap that kills the whole module, not one assertion. The same reads are
 * CORRECT on the same tree through the generic spelling — `p["length"]`
 * answers 3 — because `__extern_get` carries a `ref.test $Proxy` front-guard
 * that enters the §10.5 dispatch. The runtime was never wrong; the dot and
 * numeric-index spellings simply never asked it.
 *
 * The second half is the helper-returned proxy F3 named: `function mk(){
 * return new Proxy(t,h); }` was invisible to every admission, because none of
 * them traced a function's RETURN value. `Object.defineProperty(mk(), …)` and
 * `new (var-hop of mkc())()` ran ZERO traps on base.
 *
 * Both are the F2/F3 defect shape — a static admission that follows the
 * SPELLING rather than the VALUE — and both are closed with the same
 * predicate, `tracesToProxyValue`, so the creator and every consumer agree by
 * construction.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` as module-scope JavaScript; return the `__f4` bitmask/value. */
async function runModuleScopeJs(body: string): Promise<number> {
  const source = `var __f4 = 0;\n${body}\nexport function readResult() { return __f4; }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6651-f4.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports ?? [], "standalone module must import nothing").toEqual([]);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  const exports = instance.exports as { __module_init?: () => void; readResult: () => number };
  exports.__module_init?.();
  return exports.readResult();
}

describe("#6651 F4 — a proxy is read and written as a proxy, not as its target's shape", () => {
  it("RED on base (answered 0): `.length` of a proxy over an array", async () => {
    expect(
      await runModuleScopeJs(`
      var p = new Proxy([1, 2, 3], {});
      __f4 = p.length;`),
    ).toBe(3);
  });

  it("RED on base (answered NaN): a numeric index on a proxy over an array", async () => {
    expect(
      await runModuleScopeJs(`
      var p = new Proxy([7, 8, 9], {});
      __f4 = p[1];`),
    ).toBe(8);
  });

  it("RED on base (hard wasm trap): `.length` of a proxy over a String object completes", async () => {
    // The VALUE is still wrong on both trees (the dynamic get route does not
    // know a String object's own `length` — a separate standalone defect, see
    // the receipt). What this pin owns is that the read no longer TRAPS: on
    // base it died with "dereferencing a null pointer" before this line ran.
    expect(
      await runModuleScopeJs(`
      var p = new Proxy(new String("str"), {});
      var r = p.length;
      __f4 = 42;`),
    ).toBe(42);
  });

  it("RED on base (array untouched): `p.length = 0` through a proxy truncates the target", async () => {
    expect(
      await runModuleScopeJs(`
      var a = [1, 2, 3];
      var p = new Proxy(a, {});
      p.length = 0;
      __f4 = a.length;`),
    ).toBe(0);
  });

  it("RED on base (0 trap calls): `p.length = 0` runs an installed `set` trap", async () => {
    expect(
      await runModuleScopeJs(`
      var p = new Proxy([1, 2, 3], { set: function (t, k, v) { __f4 += 1; t[k] = v; return true; } });
      p.length = 0;`),
    ).toBe(1);
  });

  it("RED on base (0 trap calls): a helper-RETURNED proxy runs its defineProperty trap", async () => {
    expect(
      await runModuleScopeJs(`
      var h = { defineProperty: function (t, k, d) { __f4 += 1; return true; } };
      function mk() { return new Proxy({}, h); }
      Object.defineProperty(mk(), "x", { value: 1 });
      var m = mk();
      Object.defineProperty(m, "y", { value: 2 });`),
    ).toBe(2);
  });

  it("RED on base (0 trap calls): a helper-returned proxy runs its construct trap", async () => {
    expect(
      await runModuleScopeJs(`
      var h = { construct: function (t, args, nt) { __f4 += 1; return {}; } };
      function mkc() { return new Proxy(function () {}, h); }
      var mc = mkc();
      var o = new mc();`),
    ).toBe(1);
  });

  it("control, green on both sides: a nested proxy over a plain object still forwards", async () => {
    // `tracesToProxyValue` was already true for this shape, and the generic
    // route already handled it. The pin says this slice did not disturb it.
    expect(
      await runModuleScopeJs(`
      var inner = new Proxy({}, { get: function (t, k) { __f4 += 1; return 42; } });
      var outer = new Proxy(inner, {});
      var r = outer.zz;
      if (r !== 42) __f4 = 100;`),
    ).toBe(1);
  });

  it("control, green on both sides: a plain array keeps its native length/index fast path", async () => {
    // The predicate answers false here, so the arms this slice added never
    // fire and the ordinary vec lowering is unchanged.
    expect(
      await runModuleScopeJs(`
      var a = [4, 5, 6];
      __f4 = a.length * 10 + a[2];`),
    ).toBe(36);
  });

  it("control, green on both sides: a REASSIGNED helper binding declines the hop", async () => {
    // `singleReturnExpressionOfCall` refuses a callee whose name is written to
    // anywhere in the file, so this program keeps the base lowering. It is a
    // plain object by the time `defineProperty` runs, so the trap count stays 0.
    expect(
      await runModuleScopeJs(`
      var h = { defineProperty: function (t, k, d) { __f4 += 1; return true; } };
      function mk() { return new Proxy({}, h); }
      mk = function () { return {}; };
      Object.defineProperty(mk(), "x", { value: 1 });`),
    ).toBe(0);
  });
});
