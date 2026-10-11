// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster F, slice F2) Three `--target standalone` answers that were
 * wrong because a check DECLINED on a value it should have rejected.
 *
 *  1. `Object.getPrototypeOf(<integrity-marked binding>)` folded to
 *     `%Object.prototype%` for EVERY marked identifier — including one whose
 *     prototype was chosen at creation (`Object.create(p)`,
 *     `Object.setPrototypeOf({}, p)`). The runtime link was fine throughout:
 *     the same query through a helper function, through
 *     `Reflect.getPrototypeOf`, or through an alias answered correctly. Only
 *     the folded spelling was wrong, and only AFTER the integrity call, because
 *     `ctx.nonExtensibleVars` is filled as statements are compiled.
 *  2. §28.1.1 step 2 (CreateListFromArrayLike) declined a LITERAL `null` /
 *     `undefined` argumentsList, so `Reflect.apply(fn, null, null)` invoked
 *     `fn` with an empty list instead of throwing.
 *  3. §28.1.2 step 1 (`IsConstructor(target)`) was never checked — only the
 *     newTarget was — so `Reflect.construct(1, [])` answered an object.
 *
 * Shape note: every case is compiled as **JavaScript at module scope**
 * (`allowJs`, `deferTopLevelInit`), not as a TypeScript `export function
 * test()`. That is load-bearing for case 1 — the fold it narrows is reached
 * through the expando-inferred JS binding shape test262 rows are written in,
 * and a TS-typed local takes a different arm. The test262 ORIGINAL-HARNESS
 * assembly reproduces all three too, but compiling it needs more than the
 * 512 MB `VITEST_FORK_MAX_OLD_SPACE_SIZE` the unit lane runs under, so the
 * committed pin uses the same module-scope JS with a hand-rolled check.
 *
 * Every `it` was run against this branch's base first and answered exactly as
 * its RED / GUARD label says.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile `body` as module-scope JavaScript and return the value its
 * `__f2_result` binding holds after module init. Each check in `body` adds a
 * distinct bit, so a failure names which half broke.
 */
async function runModuleScopeJs(body: string): Promise<number> {
  const source = `var __f2_result = 0;\n${body}\nexport function readResult() { return __f2_result; }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6651-f2.js",
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

describe("#6651 F2 — integrity does not erase an explicitly chosen prototype", () => {
  it("RED on base: a non-extensible Object.create(p) binding keeps p as its prototype", async () => {
    expect(
      await runModuleScopeJs(`
      var proto = { tag: 1 };
      var a = Object.create(proto);
      if (Object.getPrototypeOf(a) === proto) __f2_result += 1;
      Object.preventExtensions(a);
      if (Object.getPrototypeOf(a) === proto) __f2_result += 2;
      if (a.tag === 1) __f2_result += 4;`),
    ).toBe(7);
  });

  it("RED on base: a non-extensible Object.setPrototypeOf(...) binding keeps its prototype", async () => {
    expect(
      await runModuleScopeJs(`
      var proto = { tag: 1 };
      var t = Object.setPrototypeOf({}, proto);
      Object.preventExtensions(t);
      if (Object.getPrototypeOf(t) === proto) __f2_result += 1;`),
    ).toBe(1);
  });

  // `Object.create(null)` is an explicitly NULL prototype, and the fold claimed
  // it too — so this one is RED on base for the same reason as the two above.
  it("RED on base: a non-extensible Object.create(null) binding still answers null", async () => {
    expect(
      await runModuleScopeJs(`
      var n = Object.create(null);
      Object.preventExtensions(n);
      if (Object.getPrototypeOf(n) === null) __f2_result += 1;`),
    ).toBe(1);
  });

  it("GUARD: a plain non-extensible object literal still answers %Object.prototype%", async () => {
    expect(
      await runModuleScopeJs(`
      var o = {};
      Object.preventExtensions(o);
      if (Object.getPrototypeOf(o) === Object.prototype) __f2_result += 1;
      var s = {};
      Object.preventExtensions(s);
      if (Reflect.setPrototypeOf(s, { other: 1 }) === false) __f2_result += 2;
      if (Object.getPrototypeOf(s) === Object.prototype) __f2_result += 4;`),
    ).toBe(7);
  });
});

describe("#6651 F2 — §28.1 argument preconditions", () => {
  it("RED on base: Reflect.apply throws for a literally nullish argumentsList", async () => {
    expect(
      await runModuleScopeJs(`
      var calls = 0;
      function fn() { calls++; }
      try { Reflect.apply(fn, null, null); } catch (e) { if (e instanceof TypeError) __f2_result += 1; }
      try { Reflect.apply(fn, null, undefined); } catch (e) { if (e instanceof TypeError) __f2_result += 2; }
      try { Reflect.apply(fn, null); } catch (e) { if (e instanceof TypeError) __f2_result += 4; }
      if (calls === 0) __f2_result += 8;`),
    ).toBe(15);
  });

  it("RED on base: Reflect.construct throws on a statically non-constructor target", async () => {
    expect(
      await runModuleScopeJs(`
      try { Reflect.construct(1, []); } catch (e) { if (e instanceof TypeError) __f2_result += 1; }
      try { Reflect.construct(null, []); } catch (e) { if (e instanceof TypeError) __f2_result += 2; }
      try { Reflect.construct({}, []); } catch (e) { if (e instanceof TypeError) __f2_result += 4; }
      try { Reflect.construct(Date.now, []); } catch (e) { if (e instanceof TypeError) __f2_result += 8; }`),
    ).toBe(15);
  });

  it("GUARD: real constructors and real argument lists are untouched", async () => {
    expect(
      await runModuleScopeJs(`
      function F(a) { this.a = a; }
      if (Reflect.construct(F, [7]).a === 7) __f2_result += 1;
      function sum(a, b) { return a + b; }
      if (Reflect.apply(sum, null, [1, 2]) === 3) __f2_result += 2;
      if (Reflect.apply(sum, null, { length: 2, 0: 4, 1: 5 }) === 9) __f2_result += 4;`),
    ).toBe(7);
  });
});
