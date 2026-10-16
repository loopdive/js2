// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4481 — `x.toString === X.prototype.toString`: the INSTANCE side of a builtin
 * prototype-method VALUE read under `--target standalone`.
 *
 * ## Why these assertions are shaped the way they are
 *
 * The prototype side was ALREADY an identity-stable per-(brand, member)
 * singleton on base (`Proto.m === Proto.m` true in all 20 probed cells). The
 * whole defect was that the instance side read as `undefined` — and
 * `typeof [].toString` still answered `"function"`, because `typeof` folds from
 * the receiver's TS type rather than from the emitted value.
 *
 * That is the #4234 masking trap one level up, and it dictates the test shapes:
 *
 *  - never assert `typeof` alone — it passed for the broken compiler;
 *  - never assert `a.m === undefined` alone either — `undefined === undefined`
 *    is the OTHER half of the same trap;
 *  - always establish that BOTH sides are a real function AND that they are
 *    each other (`isFn(a.m) && a.m === P.m`).
 *
 * The DECLINE group is equally load-bearing. A fold that outruns a shadowing
 * own property is this campaign's documented bug class (#4460), so each shadow
 * shape asserts both `!==` and the OWN value actually observed.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile as JAVASCRIPT (what test262 does) and run host-free. The empty
 * import list is not decoration: the identity value is a self-contained
 * closure singleton, and a fold that reached for a host import would be a
 * standalone-gap regression (#2860) rather than a fix.
 */
async function runStandalone(body: string, fn = "f"): Promise<unknown> {
  const r = await compile(`export function ${fn}() { ${body} }`, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-4481.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

/** `1` when `test` holds. Keeps every case a single boolean observation. */
const truth = (setup: string, test: string): string => `${setup} return (${test}) ? 1 : 0;`;

/**
 * Both sides are a function AND they are the same function.
 *
 * `typeof` alone is exactly the assertion the BROKEN compiler passed, so it is
 * only ever used here CONJOINED with the identity — never as the whole test.
 */
const sameFn = (inst: string, proto: string): string =>
  `typeof ${proto} === "function" && typeof ${inst} === "function" && ${inst} === ${proto}`;

describe("#4481 — instance-side builtin proto method IS the prototype's", () => {
  it.each([
    ["array toString", "var a = [1,2];", "a.toString", "Array.prototype.toString"],
    ["array valueOf", "var a = [1,2];", "a.valueOf", "Array.prototype.valueOf"],
    ["array join", "var a = [1,2];", "a.join", "Array.prototype.join"],
    [
      "array inherits Object.prototype.hasOwnProperty",
      "var a = [1,2];",
      "a.hasOwnProperty",
      "Object.prototype.hasOwnProperty",
    ],
    ["object literal toString", "var o = {};", "o.toString", "Object.prototype.toString"],
    ["object literal with a key", 'var o = {"x": true};', "o.toString", "Object.prototype.toString"],
    ["object literal valueOf", "var o = {};", "o.valueOf", "Object.prototype.valueOf"],
    ["object literal hasOwnProperty", "var o = {};", "o.hasOwnProperty", "Object.prototype.hasOwnProperty"],
    ["number toString", "var n = 5;", "n.toString", "Number.prototype.toString"],
    ["number valueOf", "var n = 5;", "n.valueOf", "Number.prototype.valueOf"],
    ["boolean toString", "var b = true;", "b.toString", "Boolean.prototype.toString"],
    ["string toString", 'var s = "s";', "s.toString", "String.prototype.toString"],
    ["string charAt", 'var s = "s";', "s.charAt", "String.prototype.charAt"],
    ["parenthesized literal receiver", "", "({}).toString", "Object.prototype.toString"],
  ])("%s", async (_label, setup, inst, proto) => {
    expect(await runStandalone(truth(setup, sameFn(inst, proto)))).toBe(1);
  });

  it("is ONE object across two receivers of the same brand", async () => {
    expect(
      await runStandalone(truth("var a = [1]; var b = [2,3];", 'a.join === b.join && typeof a.join === "function"')),
    ).toBe(1);
  });

  it("keeps DISTINCT members distinct — the fold is per (brand, member)", async () => {
    expect(await runStandalone(truth("var a = [1];", "a.join !== a.toString"))).toBe(1);
  });

  it("keeps DISTINCT brands distinct — Array.toString is not Object.toString", async () => {
    expect(await runStandalone(truth("var a = [1]; var o = {};", "a.toString !== o.toString"))).toBe(1);
  });
});

describe("#4481 — shadowing DEFEATS the fold (absent-not-wrong)", () => {
  it.each([
    // An own property in the literal itself.
    ["own property in the literal", 'var o = {toString: function(){ return "own"; }};', "o.toString"],
    // An own property installed after construction, on the same receiver…
    ["own property assigned later", 'var o = {}; o.toString = function(){ return "own"; };', "o.toString"],
    // …and on a DIFFERENT receiver: the module-wide gate is deliberately
    // coarse, because proving which receiver a write lands on is exactly the
    // analysis this arm refuses to bet on.
    [
      "a same-named write elsewhere in the module",
      "var q = {}; q.valueOf = function(){ return 7; }; var o = {};",
      "o.valueOf",
    ],
    ["an array element method shadowed", 'var a = [1,2]; a.join = function(){ return "own"; };', "a.join"],
    ["a delete of the same name", "var o = {}; o.valueOf = 1; delete o.valueOf;", "o.valueOf"],
    [
      "a defineProperty with that key",
      'var o = {}; Object.defineProperty(o, "valueOf", {value: function(){ return 9; }});',
      "o.valueOf",
    ],
    // Prototype RELINKING invalidates every brand at once.
    ["Object.setPrototypeOf anywhere", "var o = {}; Object.setPrototypeOf(o, null);", "o.toString"],
    ["Object.create anywhere", "var p = {}; var q = Object.create(p); var o = {};", "o.toString"],
    ["a `__proto__` write (§B.3.1 relink)", "var o = {}; o.__proto__ = null;", "o.toString"],
    // (A write onto a BUILTIN prototype is the separate test below: there the
    // instance read and the prototype read are the SAME user function, so the
    // `!==` shape of this table is the wrong JS answer for it.)
    // Reassignment invalidates the object-literal proof.
    ["a reassigned binding", "var o = {}; o = [1,2];", "o.toString"],
  ])("declines: %s", async (_label, setup, inst) => {
    const proto = inst.startsWith("a.") ? "Array.prototype" : "Object.prototype";
    const member = inst.slice(inst.indexOf(".") + 1);
    expect(await runStandalone(truth(setup, `${inst} !== ${proto}.${member}`))).toBe(1);
  });

  // A write onto a BUILTIN prototype is on the chain and must disable the
  // fold: the instance must read the USER function, which IS the prototype's
  // member now. This row used to sit in the `!==` table above and assert
  // `a.valueOf !== Array.prototype.valueOf` — false in JS, since both name the
  // user function; it passed only while one side still read the builtin.
  // Main answers the identity JS-correctly as of 2026-10-16 (#7014).
  it("declines: a write onto the builtin prototype (instance and prototype read the same user function)", async () => {
    const setup = 'Array.prototype.valueOf = function(){ return "poly"; }; var a = [1];';
    expect(
      await runStandalone(truth(setup, 'typeof a.valueOf === "function" && a.valueOf === Array.prototype.valueOf')),
    ).toBe(1);
  });

  // RESIDUAL (#7014, measured 2026-10-16): the identity above is right, but
  // CALLING the user function through the instance does not return its value —
  // `a.valueOf()` and `Array.prototype.valueOf()` both answer something other
  // than "poly". Pinned so a fix shows up here.
  it.fails("RESIDUAL: calling a user function installed on a builtin prototype returns its value", async () => {
    const setup = 'Array.prototype.valueOf = function(){ return "poly"; }; var a = [1];';
    expect(await runStandalone(truth(setup, 'a.valueOf() === "poly"'))).toBe(1);
  });

  it("still observes the OWN value it declined for", async () => {
    // The decline is only worth anything if the runtime read still works.
    expect(await runStandalone(truth("var o = {}; o.valueOf = function(){ return 7; };", "o.valueOf() === 7"))).toBe(1);
  });

  it("does not fold a USER constructor's instance onto Object.prototype", async () => {
    const setup = "function C(){} C.prototype.valueOf = function(){ return 5; }; var c = new C();";
    expect(await runStandalone(truth(setup, "c.valueOf !== Object.prototype.valueOf"))).toBe(1);
  });

  it("is NOT disabled by a user-prototype write of the same name (sta.js's shape)", async () => {
    // `Test262Error.prototype.toString = …` is prepended to EVERY test262 file.
    // Without the user-prototype carve-out this one line disabled the whole
    // corpus's `toString` fold — measured: 0 of 5 brands vs 5 of 5 with it.
    const setup = 'function E(m){ this.m = m; } E.prototype.toString = function(){ return "E"; }; var a = [1,2];';
    expect(await runStandalone(truth(setup, sameFn("a.toString", "Array.prototype.toString")))).toBe(1);
  });
});

describe("#4481 — the call path is unchanged", () => {
  it.each([
    ["array join", "var a = [1,2];", 'a.join("-") === "1-2"'],
    ["array toString", "var a = [1,2];", 'a.toString() === "1,2"'],
    ["object toString", "var o = {x:1};", 'o.toString() === "[object Object]"'],
    ["object hasOwnProperty", "var o = {x:1};", 'o.hasOwnProperty("x") === true'],
    ["object valueOf identity", "var o = {x:1};", "o.valueOf() === o"],
    ["number toString(radix)", "var n = 255;", 'n.toString(16) === "ff"'],
    ["string charAt", 'var s = "abc";', 's.charAt(1) === "b"'],
  ])("direct call still works: %s", async (_label, setup, test) => {
    expect(await runStandalone(truth(setup, test))).toBe(1);
  });

  it("the folded VALUE is callable exactly as the prototype's is", async () => {
    // Base answered an UNCATCHABLE `illegal cast` RuntimeError here (the value
    // was `undefined` and the `.call` receiver cast trapped). Both spellings
    // must now agree, which is the only claim identity licenses.
    const setup = "var o = {}; var viaInstance = o.toString; var viaProto = Object.prototype.toString;";
    expect(await runStandalone(truth(setup, "viaInstance.call([]) === viaProto.call([])"))).toBe(1);
  });

  it("an instance-read member's value-call runs (was a CATCHABLE refusal)", async () => {
    // When #4481 landed, `Array.prototype.join` had no native value-call body,
    // so the factory's `refusalBodyFallback` threw a CATCHABLE TypeError rather
    // than trapping, and this pinned that. The body is wired on main as of
    // 2026-10-16 (#7014): the call succeeds with the JS answer, which is what
    // this asserts now (3 would be a wrong answer, 2 the old refusal).
    const src = `var a = [1,2];
      try { return a.join.call(a, "-") === "1-2" ? 1 : 3; }
      catch (e) { return (e instanceof TypeError) ? 2 : 4; }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("the two `.call` SITES now agree — both succeed", async () => {
    // Pinned at #4481 as `21`: `Array.prototype.join.call(a, "-")` SUCCEEDED
    // while `a.join.call(a, "-")` threw, because the proto spelling is claimed
    // SYNTACTICALLY by calls.ts's reflective `.call` route and equal VALUES did
    // not imply equal call SITES. With the instance-side value-call wired (see
    // above) both succeed — `11`, the JS answer (measured 2026-10-16, #7014).
    const src = `var a = [1,2];
      var viaInstance = 0, viaProto = 0;
      try { a.join.call(a, "-"); viaInstance = 1; } catch (e) { viaInstance = (e instanceof TypeError) ? 2 : 3; }
      try { Array.prototype.join.call(a, "-"); viaProto = 1; } catch (e) { viaProto = (e instanceof TypeError) ? 2 : 3; }
      return viaInstance * 10 + viaProto;`;
    expect(await runStandalone(src)).toBe(11);
  });
});

describe("#4481 — measured residuals", () => {
  it("makes an instance-borrowed `hasOwnProperty` CALLABLE", async () => {
    // `o.hasOwnProperty.call(x, k)` now reaches the same refusal the prototype
    // spelling reaches (`… is not yet implemented in --target standalone`)
    // instead of `Cannot read properties of undefined`. Same TypeError either
    // way — a wiring gap in the native method body, tracked separately.
    expect(
      await runStandalone(truth("var probe = {}; var o = {x:1};", 'probe.hasOwnProperty.call(o, "x") === true')),
    ).toBe(1);
  });
});
